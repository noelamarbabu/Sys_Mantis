const { runBacktest } = require("./advanced_backtest");
const { getQuickTradeDecision } = require("./quick_trade_check");

async function runTradingSequence() {
  try {
    console.log("\n=== 🚀 Running Trading Sequence ===");

    // Step 1: Run Historical Backtest
    console.log("\n📊 Step 1: Running Historical Backtest...");
    await runBacktest();

    // Step 2: Get Current Trading Signal
    console.log("\n🎯 Step 2: Getting Current Trading Signal...");
    await getQuickTradeDecision();

    console.log("\n✅ Trading sequence completed successfully!\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runTradingSequence();
}
