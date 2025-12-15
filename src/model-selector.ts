import { TestResult } from './failure-tester';
import { FailureBudget, FailureBudgetAnalyzer } from './failure-budget';

interface ModelRecommendation {
  recommendedModel: string;
  reasoning: string;
  alternatives: Array<{
    model: string;
    tradeoff: string;
    pros: string[];
    cons: string[];
  }>;
  costAnalysis: {
    monthly10M: number;
    monthly100M: number;
    perRequest: number;
  };
  confidenceScore: number; // 0-100
}

interface ModelCandidate {
  model: string;
  provider: string;
  risk: number;
  violations: string[];
  avgLatency: number;
  avgCost: number;
  passRate: number;
}

export class ModelSelector {
  private analyzer: FailureBudgetAnalyzer;

  constructor() {
    this.analyzer = new FailureBudgetAnalyzer();
  }

  selectBestModel(
    useCase: string,
    failureBudget: FailureBudget,
    testResults: Map<string, TestResult[]>
  ): ModelRecommendation {
    const candidates: ModelCandidate[] = [];
    
    // Evaluate each model
    for (const [modelKey, results] of testResults.entries()) {
      const [provider, model] = modelKey.split('-');
      const analysis = this.analyzer.calculateRisk(results, failureBudget);
      const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;
      const avgCost = results.reduce((sum, r) => sum + r.cost, 0) / results.length;
      const passRate = results.filter(r => r.passed).length / results.length;
      
      candidates.push({
        model: modelKey,
        provider,
        risk: analysis.riskScore,
        violations: analysis.violations,
        avgLatency,
        avgCost,
        passRate
      });
    }
    
    // Sort by multiple criteria
    candidates.sort((a, b) => {
      // Primary: Zero violations for critical use cases
      if (failureBudget.businessImpact === 'critical') {
        if (a.violations.length !== b.violations.length) {
          return a.violations.length - b.violations.length;
        }
      }
      
      // Secondary: Risk score
      if (Math.abs(a.risk - b.risk) > 0.01) {
        return a.risk - b.risk;
      }
      
      // Tertiary: Pass rate
      return b.passRate - a.passRate;
    });
    
    // Filter out models that violate critical constraints
    const viable = candidates.filter(c => {
      if (failureBudget.regulatoryRisk) {
        // For regulated use cases, zero violations allowed
        return c.violations.length === 0;
      }
      
      // For non-regulated, allow minor violations but not in critical categories
      const criticalViolations = c.violations.filter(v => 
        v.toLowerCase().includes('injection') || 
        (failureBudget.businessImpact === 'high' && v.toLowerCase().includes('hallucination'))
      );
      return criticalViolations.length === 0;
    });
    
    if (viable.length === 0) {
      return {
        recommendedModel: 'NONE',
        reasoning: 'No models meet your failure budget. Consider: (1) Relaxing non-critical constraints, (2) Adding mandatory human review, (3) Hybrid approach with multiple models, (4) Additional fine-tuning',
        alternatives: [],
        costAnalysis: { monthly10M: 0, monthly100M: 0, perRequest: 0 },
        confidenceScore: 0
      };
    }
    
    const best = viable[0];
    const alternatives = viable.slice(1, 4).map(c => this.createAlternative(c, best));
    
    return {
      recommendedModel: best.model,
      reasoning: this.createReasoning(best, failureBudget),
      alternatives,
      costAnalysis: this.calculateCostAnalysis(best),
      confidenceScore: this.calculateConfidence(best, failureBudget)
    };
  }

  private createReasoning(candidate: ModelCandidate, budget: FailureBudget): string {
    const parts: string[] = [];
    
    parts.push(`Selected for ${budget.useCase}`);
    parts.push(`Pass rate: ${(candidate.passRate * 100).toFixed(1)}%`);
    parts.push(`Risk score: $${candidate.risk.toFixed(2)}`);
    parts.push(`Avg latency: ${candidate.avgLatency.toFixed(0)}ms`);
    
    if (candidate.violations.length === 0) {
      parts.push(`✅ Meets all failure budget requirements`);
    } else {
      parts.push(`⚠️ ${candidate.violations.length} minor violations (acceptable for ${budget.businessImpact} impact)`);
    }
    
    if (budget.regulatoryRisk) {
      parts.push(`Compliance: Suitable for regulated environment`);
    }
    
    return parts.join(' | ');
  }

  private createAlternative(
    candidate: ModelCandidate,
    best: ModelCandidate
  ): { model: string; tradeoff: string; pros: string[]; cons: string[] } {
    const costDelta = (candidate.avgCost - best.avgCost) * 10_000_000;
    const latencyDelta = candidate.avgLatency - best.avgLatency;
    const riskDelta = candidate.risk - best.risk;
    
    const pros: string[] = [];
    const cons: string[] = [];
    
    if (costDelta < 0) {
      pros.push(`$${Math.abs(costDelta).toFixed(2)} cheaper per 10M tokens`);
    } else {
      cons.push(`$${costDelta.toFixed(2)} more expensive per 10M tokens`);
    }
    
    if (latencyDelta < 0) {
      pros.push(`${Math.abs(latencyDelta).toFixed(0)}ms faster`);
    } else if (latencyDelta > 10) {
      cons.push(`${latencyDelta.toFixed(0)}ms slower`);
    }
    
    if (riskDelta < 0) {
      pros.push(`${Math.abs(riskDelta / best.risk * 100).toFixed(1)}% lower risk`);
    } else if (riskDelta > 0) {
      cons.push(`${(riskDelta / best.risk * 100).toFixed(1)}% higher risk`);
    }
    
    if (candidate.violations.length < best.violations.length) {
      pros.push(`Fewer violations (${candidate.violations.length} vs ${best.violations.length})`);
    } else if (candidate.violations.length > best.violations.length) {
      cons.push(`More violations (${candidate.violations.length} vs ${best.violations.length})`);
    }
    
    return {
      model: candidate.model,
      tradeoff: this.summarizeTradeoff(costDelta, latencyDelta, riskDelta),
      pros,
      cons
    };
  }

  private summarizeTradeoff(costDelta: number, latencyDelta: number, riskDelta: number): string {
    const parts: string[] = [];
    
    if (Math.abs(costDelta) > 1) {
      parts.push(costDelta > 0 ? 'More expensive' : 'Cheaper');
    }
    
    if (Math.abs(latencyDelta) > 50) {
      parts.push(latencyDelta > 0 ? 'slower' : 'faster');
    }
    
    if (Math.abs(riskDelta) > 0.1) {
      parts.push(riskDelta > 0 ? 'higher risk' : 'lower risk');
    }
    
    return parts.length > 0 ? parts.join(', ') : 'Similar performance';
  }

  private calculateCostAnalysis(candidate: ModelCandidate): {
    monthly10M: number;
    monthly100M: number;
    perRequest: number;
  } {
    const costPer10M = candidate.avgCost * 10_000_000;
    const costPer100M = candidate.avgCost * 100_000_000;
    
    // Assume average request is ~1000 tokens
    const avgRequestTokens = 1000;
    const perRequest = candidate.avgCost * avgRequestTokens;
    
    return {
      monthly10M: costPer10M,
      monthly100M: costPer100M,
      perRequest
    };
  }

  private calculateConfidence(candidate: ModelCandidate, budget: FailureBudget): number {
    let confidence = 100;
    
    // Reduce confidence for violations
    confidence -= candidate.violations.length * 10;
    
    // Reduce confidence if pass rate is low
    if (candidate.passRate < 0.95) {
      confidence -= (0.95 - candidate.passRate) * 100;
    }
    
    // Reduce confidence for high-risk use cases with any violations
    if (budget.businessImpact === 'critical' && candidate.violations.length > 0) {
      confidence -= 30;
    }
    
    // Increase confidence for regulatory-compliant models
    if (budget.regulatoryRisk && candidate.violations.length === 0) {
      confidence = Math.min(100, confidence + 10);
    }
    
    return Math.max(0, Math.min(100, confidence));
  }

  generateSelectionReport(recommendations: Map<string, ModelRecommendation>): string {
    let report = `\n${'='.repeat(70)}\n`;
    report += `MODEL SELECTION REPORT\n`;
    report += `${'='.repeat(70)}\n\n`;
    
    for (const [useCase, rec] of recommendations.entries()) {
      report += `📋 Use Case: ${useCase}\n`;
      report += `${'-'.repeat(70)}\n`;
      
      if (rec.recommendedModel === 'NONE') {
        report += `❌ NO SUITABLE MODEL FOUND\n`;
        report += `   ${rec.reasoning}\n\n`;
        continue;
      }
      
      report += `✅ Recommended: ${rec.recommendedModel}\n`;
      report += `   Confidence: ${rec.confidenceScore}/100\n`;
      report += `   ${rec.reasoning}\n\n`;
      
      report += `💰 Cost Analysis:\n`;
      report += `   Per 10M tokens:  $${rec.costAnalysis.monthly10M.toFixed(2)}/month\n`;
      report += `   Per 100M tokens: $${rec.costAnalysis.monthly100M.toFixed(2)}/month\n`;
      report += `   Per request:     $${rec.costAnalysis.perRequest.toFixed(6)}\n\n`;
      
      if (rec.alternatives.length > 0) {
        report += `🔄 Alternatives:\n`;
        rec.alternatives.forEach((alt, i) => {
          report += `   ${i + 1}. ${alt.model}\n`;
          report += `      Tradeoff: ${alt.tradeoff}\n`;
          if (alt.pros.length > 0) {
            report += `      Pros: ${alt.pros.join(', ')}\n`;
          }
          if (alt.cons.length > 0) {
            report += `      Cons: ${alt.cons.join(', ')}\n`;
          }
        });
      }
      
      report += `\n`;
    }
    
    return report;
  }

  // Multi-model strategy recommender
  recommendMultiModelStrategy(
    useCases: FailureBudget[],
    allResults: Map<string, Map<string, TestResult[]>>
  ): string {
    let report = `\n${'='.repeat(70)}\n`;
    report += `MULTI-MODEL STRATEGY RECOMMENDATION\n`;
    report += `${'='.repeat(70)}\n\n`;
    
    const modelAssignments = new Map<string, string[]>();
    
    for (const useCase of useCases) {
      const useCaseResults = allResults.get(useCase.useCase);
      if (!useCaseResults) continue;
      
      const rec = this.selectBestModel(useCase.useCase, useCase, useCaseResults);
      
      if (rec.recommendedModel !== 'NONE') {
        if (!modelAssignments.has(rec.recommendedModel)) {
          modelAssignments.set(rec.recommendedModel, []);
        }
        modelAssignments.get(rec.recommendedModel)!.push(useCase.useCase);
      }
    }
    
    report += `Recommended Model Distribution:\n`;
    report += `${'-'.repeat(70)}\n`;
    
    for (const [model, cases] of modelAssignments.entries()) {
      report += `\n${model}:\n`;
      cases.forEach(c => {
        report += `  • ${c}\n`;
      });
    }
    
    const totalModels = modelAssignments.size;
    
    report += `\n${'='.repeat(70)}\n`;
    report += `Summary:\n`;
    report += `  Total Models Required: ${totalModels}\n`;
    report += `  Strategy: ${totalModels === 1 ? 'Single-Model' : 'Multi-Model'}\n`;
    
    if (totalModels > 1) {
      report += `\n⚠️  Multi-model architecture considerations:\n`;
      report += `  • Implement model routing logic\n`;
      report += `  • Monitor per-model performance separately\n`;
      report += `  • Manage multiple API keys and rate limits\n`;
      report += `  • Consider fallback strategies for model failures\n`;
    }
    
    return report;
  }
}
