#!/usr/bin/env node

import { LLMFailureTester } from './failure-tester';
import { productionFailureTests, criticalTests, smokeTests } from './test-cases';
import { failureBudgets, FailureBudgetAnalyzer } from './failure-budget';
import { ModelSelector } from './model-selector';

interface TestConfig {
  models: Array<{
    provider: 'anthropic' | 'openai';
    name: string;
  }>;
  testSuite: 'all' | 'critical' | 'smoke';
  exportResults: boolean;
  exportPath?: string;
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║        LLM Production Failure Testing Suite v1.0          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Configuration
  const config: TestConfig = {
    models: [
      { provider: 'openai', name: 'gpt-4-turbo' },
      { provider: 'openai', name: 'gpt-3.5-turbo' },
      { provider: 'anthropic', name: 'claude-3-opus-20240229' },
      { provider: 'anthropic', name: 'claude-3-sonnet-20240229' },
    ],
    testSuite: 'all',  // Change to 'critical' or 'smoke' for faster runs
    exportResults: true,
    exportPath: './test-results'
  };

  // Select test suite
  const testCases = 
    config.testSuite === 'critical' ? criticalTests :
    config.testSuite === 'smoke' ? smokeTests :
    productionFailureTests;

  console.log(`📋 Test Configuration:`);
  console.log(`   Suite: ${config.testSuite}`);
  console.log(`   Test Cases: ${testCases.length}`);
  console.log(`   Models: ${config.models.map(m => m.name).join(', ')}\n`);

  // Initialize components
  const tester = new LLMFailureTester();
  const analyzer = new FailureBudgetAnalyzer();
  const selector = new ModelSelector();

  // Phase 1: Run tests
  console.log('\n📊 PHASE 1: Running Failure Tests');
  console.log('═'.repeat(60));

  const allResults = new Map<string, any>();

  for (const model of config.models) {
    try {
      const results = await tester.runTestSuite(
        testCases,
        model.provider,
        model.name
      );
      
      allResults.set(`${model.provider}-${model.name}`, results);
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      console.error(`❌ Error testing ${model.name}: ${error.message}`);
    }
  }

  // Phase 2: Analyze against failure budgets
  console.log('\n📈 PHASE 2: Analyzing Against Failure Budgets');
  console.log('═'.repeat(60));

  for (const budget of failureBudgets) {
    console.log(`\n📋 Use Case: ${budget.useCase}`);
    console.log(`   Impact: ${budget.businessImpact} | Regulatory: ${budget.regulatoryRisk ? 'YES' : 'No'}`);
    
    for (const [modelKey, results] of allResults.entries()) {
      const analysis = analyzer.calculateRisk(results, budget);
      
      const status = analysis.overBudget ? '❌' : '✅';
      const passRate = results.filter((r: any) => r.passed).length / results.length;
      
      console.log(`   ${status} ${modelKey}`);
      console.log(`      Pass Rate: ${(passRate * 100).toFixed(1)}%`);
      console.log(`      Risk Score: $${analysis.riskScore.toFixed(2)}`);
      console.log(`      Violations: ${analysis.violations.length}`);
      
      if (analysis.violations.length > 0 && budget.businessImpact === 'critical') {
        console.log(`      ⚠️  CRITICAL USE CASE WITH VIOLATIONS!`);
      }
    }
  }

  // Phase 3: Model selection
  console.log('\n🎯 PHASE 3: Model Selection Recommendations');
  console.log('═'.repeat(60));

  const recommendations = new Map<string, any>();

  for (const budget of failureBudgets) {
    const useCaseResults = new Map<string, any>();
    
    for (const [modelKey, results] of allResults.entries()) {
      useCaseResults.set(modelKey, results);
    }
    
    const recommendation = selector.selectBestModel(
      budget.useCase,
      budget,
      useCaseResults
    );
    
    recommendations.set(budget.useCase, recommendation);
    
    console.log(`\n📋 ${budget.useCase}`);
    console.log(`   Recommended: ${recommendation.recommendedModel}`);
    
    if (recommendation.recommendedModel !== 'NONE') {
      console.log(`   Confidence: ${recommendation.confidenceScore}/100`);
      console.log(`   Cost (10M tokens): $${recommendation.costAnalysis.monthly10M.toFixed(2)}/month`);
      
      if (recommendation.alternatives.length > 0) {
        console.log(`   Alternatives:`);
        recommendation.alternatives.forEach((alt: any, i: number) => {
          console.log(`      ${i + 1}. ${alt.model} - ${alt.tradeoff}`);
        });
      }
    } else {
      console.log(`   ⚠️  ${recommendation.reasoning}`);
    }
  }

  // Phase 4: Multi-model strategy
  console.log('\n🔄 PHASE 4: Multi-Model Strategy');
  console.log('═'.repeat(60));

  const modelAssignments = new Map<string, string[]>();
  
  for (const [useCase, rec] of recommendations.entries()) {
    if (rec.recommendedModel !== 'NONE') {
      if (!modelAssignments.has(rec.recommendedModel)) {
        modelAssignments.set(rec.recommendedModel, []);
      }
      modelAssignments.get(rec.recommendedModel)!.push(useCase);
    }
  }

  console.log(`\nModel Distribution:`);
  for (const [model, cases] of modelAssignments.entries()) {
    console.log(`\n${model}:`);
    cases.forEach(c => console.log(`  • ${c}`));
  }

  const totalModels = modelAssignments.size;
  console.log(`\nStrategy: ${totalModels === 1 ? 'Single-Model ✅' : `Multi-Model (${totalModels} models) ⚠️`}`);

  // Phase 5: Export results
  if (config.exportResults) {
    console.log('\n💾 PHASE 5: Exporting Results');
    console.log('═'.repeat(60));

    const fs = require('fs');
    const path = require('path');
    
    const exportDir = config.exportPath || './test-results';
    
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    // Export test results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    tester.exportResults(path.join(exportDir, `test-results-${timestamp}.json`));

    // Export budget analysis
    analyzer.exportBudgetCSV(failureBudgets, path.join(exportDir, `failure-budgets-${timestamp}.csv`));

    // Export recommendations
    const recommendationsData = Array.from(recommendations.entries()).map(([useCase, rec]) => ({
      useCase,
      ...rec
    }));
    
    fs.writeFileSync(
      path.join(exportDir, `recommendations-${timestamp}.json`),
      JSON.stringify(recommendationsData, null, 2)
    );

    console.log(`✅ Results exported to: ${exportDir}`);
  }

  // Final summary
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('✨ Test Suite Complete!');
  console.log('═'.repeat(60));
  
  const totalTests = testCases.length * config.models.length;
  const totalPassed = Array.from(allResults.values())
    .flat()
    .filter((r: any) => r.passed)
    .length;
  
  console.log(`\nOverall Results:`);
  console.log(`  Tests Run: ${totalTests}`);
  console.log(`  Passed: ${totalPassed} (${(totalPassed/totalTests*100).toFixed(1)}%)`);
  console.log(`  Failed: ${totalTests - totalPassed}`);
  
  const totalCost = Array.from(allResults.values())
    .flat()
    .reduce((sum: number, r: any) => sum + r.cost, 0);
  
  console.log(`  Total Cost: $${totalCost.toFixed(4)}\n`);

  // Critical warnings
  const criticalFailures = Array.from(allResults.entries())
    .filter(([_, results]) => {
      const criticalTests = results.filter((r: any) => 
        r.testId.startsWith('HALL-') || r.testId.startsWith('INJ-')
      );
      return criticalTests.some((r: any) => !r.passed);
    });

  if (criticalFailures.length > 0) {
    console.log('🚨 CRITICAL WARNINGS:');
    criticalFailures.forEach(([model, _]) => {
      console.log(`   • ${model} has critical test failures`);
    });
    console.log('   Review before production deployment!\n');
  }
}

// Error handling
main().catch(error => {
  console.error('\n❌ Fatal Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
