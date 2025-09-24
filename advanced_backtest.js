// Filename: advanced_backtest.js
// To run: node advanced_backtest.js
// Prerequisites: npm install ora@5 yahoo-finance2 technicalindicators exceljs dotenv fs-extra groq-sdk node-telegram-bot-api puppeteer chart.js chartjs-node-canvas

const yahooFinance = require("yahoo-finance2").default;
const { SMA, RSI, ADX } = require("technicalindicators");
const ExcelJS = require("exceljs");
const dotenv = require("dotenv");
const fs = require("fs-extra");
const Groq = require("groq-sdk");
const puppeteer = require("puppeteer");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
const TelegramBot = require("node-telegram-bot-api");
const ora = require("ora");
const {
  LinearScale,
  CategoryScale,
  PointElement,
  LineElement,
  Title,
  Legend,
  LogarithmicScale,
  Tooltip,
  Filler,
  Chart,
} = require("chart.js");

// Register the required Chart.js components
Chart.register(
  LinearScale,
  CategoryScale,
  PointElement,
  LineElement,
  Title,
  Legend,
  LogarithmicScale,
  Tooltip,
  Filler
);

// Enable charts in ExcelJS
ExcelJS.Workbook.prototype.addChart = function (opts) {
  throw new Error(
    "Charts are not supported in this version of ExcelJS. Consider using alternative charting methods."
  );
};

dotenv.config();

// --- CONFIGURATION ---
const CONFIG = {
  signalEtf: "QQQ",
  volatilityTicker: "^VIX",
  longEtf: "TQQQ",
  shortEtf: "SQQQ",
  safeEtf: "QQQ",
  longLeveragedEtf: "TQQQ", // Added missing property
  shortLeveragedEtf: "SQQQ", // Added missing property
  startDate: "2010-01-01",
  endDate: new Date().toISOString().split("T")[0],
  initialCapital: 100000,
  transactionCost: 5.0,
  riskFreeRate: 0.02,
  baseSignal: { rsiPeriod: 2, rsiOversold: 10, rsiOverbought: 90 },
  riskManagement: { stopLossPercent: 0.1, maxHoldPeriod: 10 },
  aiModelName_Report: process.env.AI_MODEL_NAME_1 || "llama3-70b-8192",
  aiModelName_Analysis: process.env.AI_MODEL_NAME_2 || "llama3-8b-8192",
  outputDir: "backtest",
  excelFilename: "backtest_performance.xlsx",
  pdfFilename: "backtest_reports.pdf",
};

// --- DUAL AI CLIENT SETUP ---
const groqReportClient = new Groq({ apiKey: process.env.GROQ_API_KEY_1 });
const groqAnalysisClient = new Groq({ apiKey: process.env.GROQ_API_KEY_2 });

// --- ALL FUNCTIONS ---

async function getAIHeuristics() {
  const spinner = ora(
    `🧠 Querying AI Strategist (${CONFIG.aiModelName_Report}) for trading rules...`
  ).start();
  const prompt = `
You are a Senior Quantitative Strategist. Your task is to generate a set of simple, machine-readable filtering rules (heuristics) to improve a base trading signal.
**Base Signal:** A trade is considered when the QQQ ETF's daily RSI(2) is oversold (<10) for a long position in TQQQ, or overbought (>90) for a long position in SQQQ.
**Your Task:** Generate a set of quantitative filters to improve the quality of this base signal. The rules should filter out bad trades in unfavorable market conditions.
Provide your response ONLY in a single JSON object with the exact structure below.
\`\`\`json
{
  "min_adx_threshold": 20,
  "max_vix_threshold": 35,
  "bullish_confirmation": { "require_price_above_sma50": true, "require_price_above_sma200": false },
  "bearish_confirmation": { "require_price_below_sma50": true, "require_price_below_sma200": false },
  "justification": "These heuristics filter for trades during moderately trending markets (ADX > 20) while avoiding extreme market fear (VIX < 35). The SMA confirmation rules prevent buying into a dip that has already broken its medium-term trend structure."
}
\`\`\`
    `;

  try {
    const completion = await groqReportClient.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: CONFIG.aiModelName_Report,
    });
    const responseText = completion.choices[0]?.message?.content || "{}";
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    const rules = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);
    spinner.succeed(`✅ AI-generated heuristics received successfully.`);
    console.log(`   └─ Justification: ${rules.justification}`);
    return rules;
  } catch (error) {
    spinner.fail("❌ FATAL: Could not get initial heuristics from AI.");
    throw error;
  }
}

async function runAiHeuristicStrategy(data, aiRules) {
  const spinner = ora(
    "⚙️  Running High-Speed Backtest with AI-Generated Rules..."
  ).start();
  let cash = CONFIG.initialCapital,
    equity = CONFIG.initialCapital;
  let currentPosition = "CASH",
    shares = 0;
  const trades = [],
    simulationLog = [];
  let isInLeveragedTrade = false,
    daysInTrade = 0,
    entryPrice = 0;

  currentPosition = CONFIG.safeEtf;
  shares = (cash - CONFIG.transactionCost) / data[0][CONFIG.safeEtf].close;
  cash = 0;

  for (const day of data) {
    equity = cash + shares * day[currentPosition].close;
    if (isInLeveragedTrade) {
      daysInTrade++;
      let exitReason = null;
      if (daysInTrade >= CONFIG.riskManagement.maxHoldPeriod)
        exitReason = "TIME STOP";
      if (
        !exitReason &&
        day[currentPosition].close <
          entryPrice * (1 - CONFIG.riskManagement.stopLossPercent)
      )
        exitReason = "STOP LOSS";
      if (exitReason) {
        cash += shares * day[currentPosition].close - CONFIG.transactionCost;
        trades.push({
          date: day.date,
          action: `SELL (${exitReason})`,
          symbol: currentPosition,
          shares,
          price: day[currentPosition].close,
          equity,
        });
        shares = (cash - CONFIG.transactionCost) / day[CONFIG.safeEtf].close;
        cash = 0;
        currentPosition = CONFIG.safeEtf;
        trades.push({
          date: day.date,
          action: "BUY (Default)",
          symbol: currentPosition,
          shares,
          price: day[CONFIG.safeEtf].close,
          equity,
        });
        isInLeveragedTrade = false;
      }
    } else {
      const isOversold = day.rsi < CONFIG.baseSignal.rsiOversold;
      const isOverbought = day.rsi > CONFIG.baseSignal.rsiOverbought;
      let entrySignal = null;
      if (isOversold) {
        const adxCheck = day.adx > aiRules.min_adx_threshold;
        const vixCheck = day.vixClose < aiRules.max_vix_threshold;
        const sma50Check = aiRules.bullish_confirmation
          .require_price_above_sma50
          ? day.qqqClose > day.sma50
          : true;
        const sma200Check = aiRules.bullish_confirmation
          .require_price_above_sma200
          ? day.qqqClose > day.sma200
          : true;
        if (adxCheck && vixCheck && sma50Check && sma200Check)
          entrySignal = CONFIG.longLeveragedEtf;
      } else if (isOverbought) {
        const adxCheck = day.adx > aiRules.min_adx_threshold;
        const vixCheck = day.vixClose < aiRules.max_vix_threshold;
        const sma50Check = aiRules.bearish_confirmation
          .require_price_below_sma50
          ? day.qqqClose < day.sma50
          : true;
        const sma200Check = aiRules.bearish_confirmation
          .require_price_below_sma200
          ? day.qqqClose < day.sma200
          : true;
        if (adxCheck && vixCheck && sma50Check && sma200Check)
          entrySignal = CONFIG.shortLeveragedEtf;
      }
      if (entrySignal) {
        cash += shares * day[CONFIG.safeEtf].close - CONFIG.transactionCost;
        trades.push({
          date: day.date,
          action: "SELL (Entry)",
          symbol: CONFIG.safeEtf,
          shares,
          price: day[CONFIG.safeEtf].close,
          equity,
        });
        const buyPrice = day[entrySignal].close;
        shares = (cash - CONFIG.transactionCost) / buyPrice;
        cash = 0;
        currentPosition = entrySignal;
        trades.push({
          date: day.date,
          action: "BUY",
          symbol: currentPosition,
          shares,
          price: buyPrice,
          equity,
        });
        isInLeveragedTrade = true;
        daysInTrade = 0;
        entryPrice = buyPrice;
      }
    }
    simulationLog.push({
      date: day.date,
      equity,
      position: currentPosition,
      qqq_close: day[CONFIG.signalEtf].close,
    });
  }
  spinner.succeed("✅ High-speed simulation finished.");
  return { simulationLog, trades };
}

async function main() {
  console.log("--- 🚀 AI-Heuristic Backtesting Engine ---");
  try {
    await fs.ensureDir(CONFIG.outputDir);
    const aiRules = await getAIHeuristics();

    const spinner = ora("📡 Fetching historical data...").start();
    const tickers = [
      CONFIG.signalEtf,
      CONFIG.volatilityTicker,
      CONFIG.longEtf,
      CONFIG.shortEtf,
    ];
    const rawData = await fetchData(tickers, CONFIG.startDate, CONFIG.endDate);
    spinner.succeed("✅ Data fetched successfully.");

    const alignedData = alignData(rawData);
    const dataWithIndicators = calculateIndicators(alignedData);

    const { simulationLog, trades } = await runAiHeuristicStrategy(
      dataWithIndicators,
      aiRules
    );

    const metrics = calculateMetrics(
      simulationLog,
      trades,
      CONFIG.initialCapital,
      CONFIG.riskFreeRate
    );

    const aiFinalReport = await analyzePerformanceWithAI(
      trades,
      metrics,
      aiRules.justification
    );

    await generateExcelReport({
      simulationLog,
      trades,
      metrics,
      aiAnalysisReport: aiFinalReport,
    });

    const pdfReportPath = `${CONFIG.outputDir}/${CONFIG.pdfFilename}`;
    await generateAdvancedPdfReport({
      metrics,
      simulationLog,
      aiAnalysisReport: aiFinalReport, // Fixed: now passing the report correctly
    });

    console.log("\n--- ✨ Backtest Summary ---");
    console.log(
      `   Final Portfolio Value: ${metrics.finalEquity.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      })}`
    );
    console.log(`   CAGR: ${(metrics.cagr * 100).toFixed(2)}%`);
    console.log(`   Max Drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`   Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`);
    console.log("--------------------------\n");

    await sendTelegramReport({ metrics, pdfPath: pdfReportPath });
  } catch (error) {
    console.error(
      "\n--- ❌ An error occurred during the process ---",
      error.message
    );
    console.error(error.stack); // Added stack trace for better debugging
    process.exit(1);
  }
}

async function fetchData(tickers, startDate, endDate) {
  const data = {};
  for (const ticker of tickers) {
    try {
      // Using chart() instead of deprecated historical()
      const result = await yahooFinance.chart(ticker, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
      });

      // Extract quotes from chart response
      const quotes = result.quotes || [];
      data[ticker] = quotes
        .map((d) => ({
          ...d,
          date: new Date(d.date).toISOString().split("T")[0],
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    } catch (error) {
      console.error(`Failed to fetch data for ${ticker}:`, error.message);
      throw new Error(`Data fetch failed for ${ticker}`);
    }
  }
  return data;
}

function alignData(dataByTicker) {
  const allDates = new Set(
    Object.values(dataByTicker).flatMap((d) => d.map((v) => v.date))
  );
  const sortedDates = Array.from(allDates).sort();
  const alignedData = [];
  const maps = Object.fromEntries(
    Object.entries(dataByTicker).map(([k, v]) => [
      k,
      new Map(v.map((d) => [d.date, d])),
    ])
  );
  for (const date of sortedDates) {
    let dailyData = { date };
    let allPresent = true;
    for (const ticker in dataByTicker) {
      if (maps[ticker].has(date)) dailyData[ticker] = maps[ticker].get(date);
      else {
        allPresent = false;
        break;
      }
    }
    if (allPresent) alignedData.push(dailyData);
  }
  return alignedData;
}

function transpose(data) {
  return data.reduce((acc, curr) => {
    for (const key in curr) {
      if (!acc[key]) acc[key] = [];
      acc[key].push(curr[key]);
    }
    return acc;
  }, {});
}

function calculateIndicators(alignedData) {
  const spinner = ora(
    "📊 Calculating full suite of indicators (SMA, RSI, ADX)..."
  ).start();

  if (alignedData.length === 0) {
    spinner.fail("❌ No aligned data available for indicator calculation.");
    throw new Error("No aligned data available");
  }

  const qqqData = alignedData.map((d) => d[CONFIG.signalEtf]);

  const qqqCloses = qqqData.map((d) => d.close);

  // Add validation for minimum data requirements
  if (qqqCloses.length < 200) {
    spinner.fail(
      `❌ Insufficient data: ${qqqCloses.length} days, need at least 200.`
    );
    throw new Error("Insufficient historical data for indicators");
  }

  const rsi = RSI.calculate({
    period: CONFIG.baseSignal.rsiPeriod,
    values: qqqCloses,
  });
  const sma50 = SMA.calculate({ period: 50, values: qqqCloses });
  const sma200 = SMA.calculate({ period: 200, values: qqqCloses });
  const adx = ADX.calculate({
    period: 14,
    ...transpose(
      qqqData.map((d) => ({ high: d.high, low: d.low, close: d.close }))
    ),
  });

  const longestLookback = 200;

  const dataWithIndicators = alignedData
    .slice(longestLookback)
    .map((day, i) => {
      const baseIndex = i + longestLookback;
      const rsiIndex = baseIndex - CONFIG.baseSignal.rsiPeriod;
      const sma50Index = baseIndex - 50;
      const adxIndex = baseIndex - 14 * 2 + 1;

      return {
        ...day,
        qqqClose: day[CONFIG.signalEtf].close,
        vixClose: day[CONFIG.volatilityTicker].close,
        rsi: rsiIndex >= 0 && rsiIndex < rsi.length ? rsi[rsiIndex] : null,
        sma50:
          sma50Index >= 0 && sma50Index < sma50.length
            ? sma50[sma50Index]
            : null,
        sma200: i < sma200.length ? sma200[i] : null,
        adx: adxIndex >= 0 && adxIndex < adx.length ? adx[adxIndex]?.adx : null,
      };
    })
    .filter((d) => d.rsi !== null && d.sma50 !== null && d.adx !== null);

  spinner.succeed(
    `✅ Indicators calculated for ${dataWithIndicators.length} days.`
  );
  return dataWithIndicators;
}

async function analyzePerformanceWithAI(trades, metrics, justification) {
  if (trades.length === 0)
    return "No trades were made. The AI-generated heuristics may have been too strict.";
  const spinner = ora(
    `🧠 Querying AI Analyst (${CONFIG.aiModelName_Analysis}) for final report...`
  ).start();
  const prompt = `You are a Senior Quantitative Analyst. A strategy was backtested using a set of machine-readable rules that were generated by another AI. Your task is to critique the performance of these AI-generated rules.
**AI-Generated Strategy Justification:** "${justification}"
**Backtest Performance Summary:**
- Final Equity: $${metrics.finalEquity.toFixed(2)}
- CAGR: ${(metrics.cagr * 100).toFixed(2)}%
- Max Drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%
- Total Trades: ${trades.length}
**Your Task:**
1.  **Critique the Performance:** Based on the results, did the AI's heuristics lead to a viable strategy?
2.  **Critique the Heuristics:** Was the AI's justification for its rules validated by the results? Suggest one specific modification to the JSON heuristics that might improve performance.
3.  **Go/No-Go Recommendation:** Provide a clear "Go" or "No-Go" for this strategy.`;

  try {
    const completion = await groqAnalysisClient.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: CONFIG.aiModelName_Analysis,
    });
    spinner.succeed("✅ AI analysis received.");
    return completion.choices[0]?.message?.content || "No analysis returned.";
  } catch (error) {
    spinner.fail("❌ AI analysis failed.");
    console.error("AI Analysis Error:", error.message);
    return "AI analysis failed. Manual review required.";
  }
}

function calculateMetrics(simulationLog, trades, initialCapital, riskFreeRate) {
  if (simulationLog.length < 2)
    return {
      finalEquity: initialCapital,
      cagr: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      drawdowns: [],
    };
  const dailyReturns = [];
  for (let i = 1; i < simulationLog.length; i++) {
    dailyReturns.push(
      simulationLog[i].equity / simulationLog[i - 1].equity - 1
    );
  }

  const meanReturn =
    dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(
    dailyReturns
      .map((r) => Math.pow(r - meanReturn, 2))
      .reduce((a, b) => a + b, 0) / dailyReturns.length
  );
  const annualisedStdDev = stdDev * Math.sqrt(252);
  const sharpeRatio =
    annualisedStdDev > 0
      ? (meanReturn * 252 - riskFreeRate) / annualisedStdDev
      : 0;

  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  const drawdowns = simulationLog.map((day) => {
    peakEquity = Math.max(peakEquity, day.equity);
    const drawdown = (day.equity - peakEquity) / peakEquity;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    return { date: day.date, equity: day.equity, peakEquity, drawdown };
  });

  const finalEquity = simulationLog[simulationLog.length - 1].equity;
  const years =
    (new Date(simulationLog[simulationLog.length - 1].date) -
      new Date(simulationLog[0].date)) /
    31536000000;
  const cagr =
    years > 0 ? Math.pow(finalEquity / initialCapital, 1 / years) - 1 : 0;

  return { finalEquity, cagr, maxDrawdown, sharpeRatio, drawdowns };
}

async function generateAdvancedPdfReport(results) {
  const spinner = ora(
    "📑 Generating Advanced PDF Report with Charts..."
  ).start();
  const { metrics, simulationLog, aiAnalysisReport, trades = [] } = results;

  try {
    const width = 1000,
      height = 500;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: "white",
    });

    // Create equity curve chart (using line chart with fill)
    const equityCurveConfig = {
      type: "line",
      data: {
        labels: simulationLog.map((d) => d.date),
        datasets: [
          {
            label: "Sys-Mantis Strategy",
            data: simulationLog.map((d) => d.equity),
            borderColor: "#007BFF",
            backgroundColor: "rgba(0, 123, 255, 0.1)",
            borderWidth: 2,
            tension: 0.1,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        scales: {
          x: {
            type: "category",
            ticks: { autoSkip: true, maxTicksLimit: 20 },
          },
          y: {
            type: "logarithmic",
            ticks: { callback: (value) => `$${(value / 1000).toFixed(0)}k` },
          },
        },
        plugins: {
          title: {
            display: true,
            text: "Portfolio Performance",
            font: { size: 18 },
          },
          legend: { position: "bottom" },
        },
      },
    };

    // Create drawdown chart
    const drawdownConfig = {
      type: "line",
      data: {
        labels: metrics.drawdowns.map((d) => d.date),
        datasets: [
          {
            label: "Drawdown",
            data: metrics.drawdowns.map((d) => d.drawdown),
            backgroundColor: "rgba(255, 68, 68, 0.2)",
            borderColor: "#FF4444",
            borderWidth: 1,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        scales: {
          x: {
            type: "category",
            ticks: { autoSkip: true, maxTicksLimit: 20 },
          },
          y: {
            ticks: { callback: (value) => `${(value * 100).toFixed(1)}%` },
          },
        },
        plugins: {
          title: {
            display: true,
            text: "Portfolio Drawdowns",
            font: { size: 18 },
          },
        },
      },
    };

    // Generate chart images
    const equityCurveImage = await chartJSNodeCanvas.renderToBuffer(
      equityCurveConfig
    );
    const drawdownImage = await chartJSNodeCanvas.renderToBuffer(
      drawdownConfig
    );

    // Convert to base64
    const equityCurveBase64 = `data:image/png;base64,${equityCurveImage.toString(
      "base64"
    )}`;
    const drawdownBase64 = `data:image/png;base64,${drawdownImage.toString(
      "base64"
    )}`;

    // Generate monthly returns heatmap data
    const monthlyReturns = calculateMonthlyReturns(simulationLog);
    let heatmapHtml =
      '<div class="monthly-returns"><h3>Monthly Returns Heatmap</h3><table class="heatmap-table">';
    heatmapHtml +=
      "<tr><th>Year</th><th>Jan</th><th>Feb</th><th>Mar</th><th>Apr</th><th>May</th><th>Jun</th><th>Jul</th><th>Aug</th><th>Sep</th><th>Oct</th><th>Nov</th><th>Dec</th><th>Year</th></tr>";

    Object.entries(monthlyReturns).forEach(([year, returns]) => {
      heatmapHtml += "<tr>";
      heatmapHtml += `<td>${year}</td>`;
      returns.forEach((ret) => {
        if (ret === null) {
          heatmapHtml += "<td>-</td>";
        } else {
          const color = ret >= 0 ? "#00C851" : "#FF4444";
          const opacity = Math.min(Math.abs(ret), 0.5);
          heatmapHtml += `<td style="background-color: ${color}; opacity: ${opacity}">${(
            ret * 100
          ).toFixed(2)}%</td>`;
        }
      });
      heatmapHtml += "</tr>";
    });
    heatmapHtml += "</table></div>";

    const tradeAnalysis = generateTradeAnalysis(trades);

    // Create HTML content
    const htmlContent = `
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 40px;
            color: #333;
          }
          h1, h2, h3 {
            color: #1a237e;
            border-bottom: 2px solid #3949ab;
            padding-bottom: 5px;
          }
          .page-break { page-break-before: always; }
          .summary-table {
            border-collapse: collapse;
            width: 100%;
            margin: 20px 0;
          }
          .summary-table th, .summary-table td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
          }
          .summary-table th { background-color: #e8eaf6; }
          .chart-container {
            margin: 20px 0;
            text-align: center;
          }
          .heatmap-table {
            border-collapse: collapse;
            width: 100%;
            margin: 20px 0;
            font-size: 12px;
          }
          .heatmap-table th, .heatmap-table td {
            border: 1px solid #ddd;
            padding: 4px;
            text-align: center;
          }
          .trades-table {
            font-size: 12px;
            width: 100%;
            margin: 20px 0;
          }
          .trades-table th, .trades-table td {
            border: 1px solid #ddd;
            padding: 4px;
          }
          .positive { color: #00C851; }
          .negative { color: #FF4444; }
        </style>
      </head>
      <body>
        <h1>Sys-Mantis Strategy Performance Report</h1>
        <p><strong>Period:</strong> ${simulationLog[0].date} to ${
      simulationLog[simulationLog.length - 1].date
    }</p>
        
        <h2>Executive Summary</h2>
        <table class="summary-table">
          <tr>
            <th>Metric</th>
            <th>Value</th>
          </tr>
          <tr>
            <td>Final Portfolio Value</td>
            <td>${metrics.finalEquity.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
            })}</td>
          </tr>
          <tr>
            <td>CAGR</td>
            <td>${(metrics.cagr * 100).toFixed(2)}%</td>
          </tr>
          <tr>
            <td>Maximum Drawdown</td>
            <td>${(metrics.maxDrawdown * 100).toFixed(2)}%</td>
          </tr>
          <tr>
            <td>Sharpe Ratio</td>
            <td>${metrics.sharpeRatio.toFixed(2)}</td>
          </tr>
          <tr>
            <td>Win Rate</td>
            <td>${tradeAnalysis.winRate.toFixed(2)}%</td>
          </tr>
          <tr>
            <td>Profit/Loss Ratio</td>
            <td>${tradeAnalysis.profitLossRatio.toFixed(2)}</td>
          </tr>
        </table>

        <div class="chart-container">
          <img src="${equityCurveBase64}" style="width:100%; max-width:1000px;">
        </div>

        <div class="page-break"></div>
        <h2>Detailed Analysis</h2>
        ${heatmapHtml}
        
        <div class="chart-container">
          <img src="${drawdownBase64}" style="width:100%; max-width:1000px;">
        </div>

        <div class="page-break"></div>
        <h2>Trade Analysis</h2>
        <h3>Top 10 Most Profitable Trades</h3>
        <table class="trades-table">
          <tr>
            <th>Symbol</th>
            <th>Entry Date</th>
            <th>Exit Date</th>
            <th>Days</th>
            <th>Profit</th>
            <th>Return</th>
          </tr>
          ${tradeAnalysis.topTrades
            .map(
              (trade) => `
            <tr>
              <td>${trade.symbol}</td>
              <td>${trade.startDate}</td>
              <td>${trade.endDate}</td>
              <td>${trade.duration}</td>
              <td class="positive">$${trade.profit.toFixed(2)}</td>
              <td class="positive">${trade.profitPercent.toFixed(2)}%</td>
            </tr>
          `
            )
            .join("")}
        </table>

        <h3>Bottom 10 Least Profitable Trades</h3>
        <table class="trades-table">
          <tr>
            <th>Symbol</th>
            <th>Entry Date</th>
            <th>Exit Date</th>
            <th>Days</th>
            <th>Profit</th>
            <th>Return</th>
          </tr>
          ${tradeAnalysis.bottomTrades
            .map(
              (trade) => `
            <tr>
              <td>${trade.symbol}</td>
              <td>${trade.startDate}</td>
              <td>${trade.endDate}</td>
              <td>${trade.duration}</td>
              <td class="negative">$${trade.profit.toFixed(2)}</td>
              <td class="negative">${trade.profitPercent.toFixed(2)}%</td>
            </tr>
          `
            )
            .join("")}
        </table>

        <div class="page-break"></div>
        <h2>AI Analysis</h2>
        <pre style="white-space: pre-wrap; font-size: 14px; line-height: 1.6;">
${aiAnalysisReport}
        </pre>
      </body>
      </html>
    `;

    // Generate PDF
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    await page.pdf({
      path: `${CONFIG.outputDir}/${CONFIG.pdfFilename}`,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" },
    });
    await browser.close();

    spinner.succeed(
      `✅ Enhanced PDF report saved to '${CONFIG.outputDir}/${CONFIG.pdfFilename}'`
    );
  } catch (error) {
    spinner.fail("❌ PDF generation failed.");
    console.error("PDF Generation Error:", error.message);
    throw error;
  }
}

async function generateExcelReport(results) {
  const spinner = ora("🧾 Generating Excel report...").start();
  const { simulationLog, trades, metrics } = results;
  const workbook = new ExcelJS.Workbook();

  // Tab 1: EquityCurve
  const equityCurveSheet = workbook.addWorksheet("EquityCurve");
  const benchmarkData = calculateBenchmarkData(simulationLog);

  equityCurveSheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Sys-Mantis Strategy", key: "equity", width: 15 },
    { header: "QQQ Buy and Hold", key: "qqq", width: 15 },
  ];

  simulationLog.forEach((day, i) => {
    equityCurveSheet.addRow({
      date: day.date,
      equity: day.equity,
      qqq: benchmarkData[i].qqqValue,
    });
  });

  // Tab 2: MonthlyPerf
  const monthlySheet = workbook.addWorksheet("MonthlyPerf");
  const monthlyReturns = calculateMonthlyReturns(simulationLog);

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "Year",
  ];
  monthlySheet.columns = [
    { header: "Year", key: "year", width: 10 },
    ...months.map((month) => ({ header: month, width: 10 })),
  ];

  Object.entries(monthlyReturns).forEach(([year, returns]) => {
    const rowData = { year };
    returns.forEach((ret, i) => {
      rowData[months[i]] =
        ret !== null
          ? Number(ret).toLocaleString("en-US", {
              style: "percent",
              minimumFractionDigits: 2,
            })
          : "";
    });
    monthlySheet.addRow(rowData);
  });

  // Tab 3: Trades
  const tradesSheet = workbook.addWorksheet("Trades");
  const tradeAnalysis = generateTradeAnalysis(trades);

  // Strategy summary section
  tradesSheet.addRow(["Strategy Summary"]);
  tradesSheet.addRows([
    ["Strategy Name:", "Sys-Mantis"],
    ["Total Profit:", `$${tradeAnalysis.totalProfit.toFixed(2)}`],
    ["Winning Percentage:", `${tradeAnalysis.winRate.toFixed(2)}%`],
    ["Profit/Loss Ratio:", tradeAnalysis.profitLossRatio.toFixed(2)],
    ["Total Trades:", tradeAnalysis.totalTrades],
    [],
  ]);

  // Detailed trades table
  tradesSheet.addRow([
    "Symbol",
    "Start Date",
    "End Date",
    "Duration (days)",
    "Buy Price",
    "Sell Price",
    "Share Size",
    "Profit ($)",
    "Profit %",
    "Buy Info",
    "Sell Info",
  ]);

  tradeAnalysis.tradeDetails.forEach((trade) => {
    tradesSheet.addRow([
      trade.symbol,
      trade.startDate,
      trade.endDate,
      trade.duration,
      trade.buyPrice.toFixed(2),
      trade.sellPrice.toFixed(2),
      trade.shares.toFixed(2),
      trade.profit.toFixed(2),
      `${trade.profitPercent.toFixed(2)}%`,
      trade.buyInfo,
      trade.sellInfo,
    ]);
  });

  // Tab 4: Performance Metrics
  const metricsSheet = workbook.addWorksheet("Metrics");
  metricsSheet.addRows([
    ["Metric", "Value"],
    ["Initial Capital", `$${CONFIG.initialCapital.toLocaleString()}`],
    ["Final Portfolio Value", `$${metrics.finalEquity.toLocaleString()}`],
    [
      "Total Return",
      `${((metrics.finalEquity / CONFIG.initialCapital - 1) * 100).toFixed(
        2
      )}%`,
    ],
    ["CAGR", `${(metrics.cagr * 100).toFixed(2)}%`],
    ["Maximum Drawdown", `${(metrics.maxDrawdown * 100).toFixed(2)}%`],
    ["Sharpe Ratio", metrics.sharpeRatio.toFixed(2)],
    ["Win Rate", `${tradeAnalysis.winRate.toFixed(2)}%`],
    ["Average Winning Trade", `$${tradeAnalysis.avgWinning.toFixed(2)}`],
    [
      "Average Losing Trade",
      `$${Math.abs(tradeAnalysis.avgLosing).toFixed(2)}`,
    ],
    ["Profit/Loss Ratio", tradeAnalysis.profitLossRatio.toFixed(2)],
  ]);

  const filePath = `${CONFIG.outputDir}/${CONFIG.excelFilename}`;
  await workbook.xlsx.writeFile(filePath);
  spinner.succeed(`✅ Excel report saved to '${filePath}'.`);
}

async function sendTelegramReport(data) {
  const { metrics, pdfPath } = data;
  const token = process.env.TELEGRAM_API_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("⚠️  Telegram credentials not found, skipping notification.");
    return;
  }

  const spinner = ora("📲 Sending Telegram notification...").start();
  const bot = new TelegramBot(token);
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const caption = `*Hi Sys-Mantis,*\n*Back Test Report*\n*Date:* ${today}\n\n*Summary:*\n- *Final Equity:* ${metrics.finalEquity.toLocaleString(
    "en-US",
    { style: "currency", currency: "USD" }
  )}\n- *CAGR:* ${(metrics.cagr * 100).toFixed(2)}%\n- *Max Drawdown:* ${(
    metrics.maxDrawdown * 100
  ).toFixed(2)}%`;
  try {
    await bot.sendDocument(chatId, pdfPath, {
      caption: caption,
      parse_mode: "Markdown",
    });
    spinner.succeed("✅ Telegram report sent successfully!");
  } catch (error) {
    spinner.fail("❌ Failed to send Telegram report.");
    console.error("Telegram Error:", error.message);
  }
}

// --- REPORT UTILITY FUNCTIONS ---
const moment = require("moment");

function calculateMonthlyReturns(simulationLog) {
  if (!simulationLog || simulationLog.length === 0) {
    return {}; // Return empty object if no data
  }

  const returns = {};
  let prevDay = null;

  simulationLog.forEach((day) => {
    const date = new Date(day.date);
    const year = date.getFullYear();
    const month = date.getMonth();

    if (!returns[year]) {
      returns[year] = Array(12).fill(null);
    }

    if (prevDay) {
      const monthlyReturn = day.equity / prevDay.equity - 1;
      if (prevDay.date.startsWith(day.date.substring(0, 7))) {
        // Same month
        returns[year][month] =
          (1 + (returns[year][month] || 0)) * (1 + monthlyReturn) - 1;
      } else {
        // New month
        returns[year][month] = monthlyReturn;
      }
    }
    prevDay = day;
  });

  // Calculate yearly returns
  Object.keys(returns).forEach((year) => {
    const yearlyReturn = returns[year].reduce(
      (acc, ret) => (ret !== null ? (1 + acc) * (1 + ret) - 1 : acc),
      0
    );
    returns[year].push(yearlyReturn); // Add yearly return as 13th element
  });

  return returns;
}

function generateTradeAnalysis(trades) {
  const analysis = {
    totalTrades: trades.length,
    profitableTrades: 0,
    totalProfit: 0,
    totalFees: trades.length * CONFIG.transactionCost,
    winningTrades: [],
    losingTrades: [],
    tradeDetails: [],
  };

  let lastTrade = null;

  trades.forEach((trade, index) => {
    if (trade.action.startsWith("BUY")) {
      lastTrade = {
        symbol: trade.symbol,
        startDate: trade.date,
        buyPrice: trade.price,
        shares: trade.shares,
        buyInfo: trade.action,
      };
    } else if (trade.action.startsWith("SELL") && lastTrade) {
      const profit = (trade.price - lastTrade.buyPrice) * lastTrade.shares;
      const profitPercent = (trade.price / lastTrade.buyPrice - 1) * 100;
      const duration = moment(trade.date).diff(
        moment(lastTrade.startDate),
        "days"
      );
      const isProfitable = profit > 0;
      const isShort = lastTrade.symbol === CONFIG.shortLeveragedEtf;

      const tradeDetail = {
        ...lastTrade,
        endDate: trade.date,
        duration,
        sellPrice: trade.price,
        profit,
        profitPercent,
        isProfitable,
        isShort,
        sellInfo: trade.action,
      };

      analysis.tradeDetails.push(tradeDetail);

      if (isProfitable) {
        analysis.profitableTrades++;
        analysis.winningTrades.push(tradeDetail);
      } else {
        analysis.losingTrades.push(tradeDetail);
      }

      analysis.totalProfit += profit;
      lastTrade = null;
    }
  });

  analysis.winRate = (analysis.profitableTrades / analysis.totalTrades) * 100;
  analysis.avgWinning =
    analysis.winningTrades.reduce((sum, t) => sum + t.profit, 0) /
    analysis.winningTrades.length;
  analysis.avgLosing =
    analysis.losingTrades.reduce((sum, t) => sum + t.profit, 0) /
    analysis.losingTrades.length;
  analysis.profitLossRatio = Math.abs(analysis.avgWinning / analysis.avgLosing);

  // Sort trades by profit for top/bottom analysis
  analysis.tradeDetails.sort((a, b) => b.profit - a.profit);
  analysis.topTrades = analysis.tradeDetails.slice(0, 10);
  analysis.bottomTrades = analysis.tradeDetails.slice(-10).reverse();

  return analysis;
}

function calculateBenchmarkData(simulationLog) {
  const startQQQPrice = simulationLog[0].qqq_close;
  const initialCapital = CONFIG.initialCapital;
  const qqqShares = initialCapital / startQQQPrice;

  return simulationLog.map((day) => ({
    date: day.date,
    qqqValue: qqqShares * day.qqq_close,
    tqqqValue: null, // We'll skip TQQQ comparison if data isn't available
  }));
}

// Export the main functions
module.exports = {
  runBacktest: main,
  CONFIG,
};

// Only run if called directly
if (require.main === module) {
  main();
}
