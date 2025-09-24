// Filename: realtime_trading_decisions.js
// To run: node realtime_trading_decisions.js
// Prerequisites: npm install ora@5 yahoo-finance2 technicalindicators exceljs dotenv fs-extra groq-sdk node-telegram-bot-api puppeteer chart.js chartjs-node-canvas cron

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
const cron = require("cron");

dotenv.config();

// --- CONFIGURATION ---
const CONFIG = {
  signalEtf: "QQQ",
  volatilityTicker: "^VIX",
  longEtf: "TQQQ",
  shortEtf: "SQQQ",
  safeEtf: "QQQ",
  longLeveragedEtf: "TQQQ",
  shortLeveragedEtf: "SQQQ",
  lookbackPeriod: 252, // Days of historical data to analyze
  initialCapital: 100000,
  transactionCost: 5.0,
  riskFreeRate: 0.02,
  baseSignal: { rsiPeriod: 2, rsiOversold: 10, rsiOverbought: 90 },
  riskManagement: { stopLossPercent: 0.1, maxHoldPeriod: 10 },
  aiModelName_Report: process.env.AI_MODEL_NAME_1 || "llama3-70b-8192",
  aiModelName_Analysis: process.env.AI_MODEL_NAME_2 || "llama3-8b-8192",
  outputDir: "realtime_decisions",
  // Trading schedule (market hours: 9:30 AM - 4:00 PM EST)
  tradingSchedule: "0 30 9,10,11,12,13,14,15,16 * * 1-5", // Every hour during market hours, weekdays only
  timezone: "America/New_York",
};

// --- AI CLIENT SETUP ---
const groqReportClient = new Groq({ apiKey: process.env.GROQ_API_KEY_1 });
const groqAnalysisClient = new Groq({ apiKey: process.env.GROQ_API_KEY_2 });

// --- TELEGRAM BOT SETUP ---
const telegramBot = process.env.TELEGRAM_API_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_API_TOKEN, { polling: false })
  : null;

// Global state to track current position and AI rules
let currentState = {
  position: "CASH",
  aiRules: null,
  lastUpdate: null,
  currentEquity: CONFIG.initialCapital,
  positionShares: 0,
  entryPrice: 0,
  daysInPosition: 0,
  isLeveragedPosition: false,
};

// --- MAIN FUNCTIONS ---

class RealTimeTradingSystem {
  constructor() {
    this.isRunning = false;
    this.cronJob = null;
  }

  async initialize() {
    console.log("🚀 Initializing Real-Time Trading Decision System");

    try {
      await fs.ensureDir(CONFIG.outputDir);

      // Get initial AI heuristics
      currentState.aiRules = await this.getAIHeuristics();

      // Load any existing state
      await this.loadState();

      console.log("✅ System initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Initialization failed:", error.message);
      return false;
    }
  }

  async getAIHeuristics() {
    const spinner = ora("🧠 Getting AI trading heuristics...").start();

    const prompt = `
You are a Senior Quantitative Strategist providing real-time trading rules for an active trading system.

**Base Strategy:** RSI(2) mean reversion on QQQ with leveraged ETF positions (TQQQ/SQQQ).
- Long TQQQ when QQQ RSI(2) < 10 (oversold)
- Long SQQQ when QQQ RSI(2) > 90 (overbought)
- Default position: QQQ (safe haven)

**Current Market Context:** Real-time trading decisions needed.

Provide trading rules as JSON with the exact structure below:

\`\`\`json
{
  "min_adx_threshold": 20,
  "max_vix_threshold": 35,
  "min_volume_threshold": 1000000,
  "bullish_confirmation": {
    "require_price_above_sma50": true,
    "require_price_above_sma200": false,
    "require_rising_sma": true
  },
  "bearish_confirmation": {
    "require_price_below_sma50": true,
    "require_price_below_sma200": false,
    "require_falling_sma": true
  },
  "risk_management": {
    "max_position_size": 1.0,
    "intraday_stop_loss": 0.05,
    "profit_target": 0.08
  },
  "market_hours_only": true,
  "justification": "Conservative approach focusing on liquid markets with trend confirmation to reduce whipsaws in volatile conditions."
}
\`\`\``;

    try {
      const completion = await groqReportClient.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: CONFIG.aiModelName_Report,
      });

      const responseText = completion.choices[0]?.message?.content || "{}";
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
      const rules = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);

      spinner.succeed("✅ AI heuristics obtained");
      console.log(`   └─ Strategy: ${rules.justification}`);

      return rules;
    } catch (error) {
      spinner.fail("❌ Failed to get AI heuristics");
      throw error;
    }
  }

  async fetchRealTimeData() {
    const spinner = ora("📡 Fetching real-time market data...").start();

    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - CONFIG.lookbackPeriod);

      const tickers = [
        CONFIG.signalEtf,
        CONFIG.volatilityTicker,
        CONFIG.longLeveragedEtf,
        CONFIG.shortLeveragedEtf,
        CONFIG.safeEtf,
      ];

      const data = {};

      for (const ticker of tickers) {
        const result = await yahooFinance.chart(ticker, {
          period1: startDate.toISOString().split("T")[0],
          period2: endDate.toISOString().split("T")[0],
          interval: "1d",
        });

        data[ticker] = result.quotes
          .map((d) => ({
            ...d,
            date: new Date(d.date).toISOString().split("T")[0],
          }))
          .sort((a, b) => new Date(a.date) - new Date(b.date));
      }

      spinner.succeed("✅ Real-time data fetched");
      return data;
    } catch (error) {
      spinner.fail("❌ Failed to fetch real-time data");
      throw error;
    }
  }

  async calculateCurrentIndicators(rawData) {
    const spinner = ora("📊 Calculating current market indicators...").start();

    try {
      const alignedData = this.alignData(rawData);
      const qqqData = alignedData.map((d) => d[CONFIG.signalEtf]);
      const qqqCloses = qqqData.map((d) => d.close);

      // Calculate indicators
      const rsi = RSI.calculate({
        period: CONFIG.baseSignal.rsiPeriod,
        values: qqqCloses,
      });

      const sma50 = SMA.calculate({ period: 50, values: qqqCloses });
      const sma200 = SMA.calculate({ period: 200, values: qqqCloses });

      const adx = ADX.calculate({
        period: 14,
        high: qqqData.map((d) => d.high),
        low: qqqData.map((d) => d.low),
        close: qqqData.map((d) => d.close),
      });

      // Get the latest values
      const latestData = alignedData[alignedData.length - 1];
      const currentIndicators = {
        date: latestData.date,
        qqqClose: latestData[CONFIG.signalEtf].close,
        vixClose: latestData[CONFIG.volatilityTicker].close,
        tqqqClose: latestData[CONFIG.longLeveragedEtf].close,
        sqqqClose: latestData[CONFIG.shortLeveragedEtf].close,
        volume: latestData[CONFIG.signalEtf].volume,
        rsi: rsi[rsi.length - 1],
        sma50: sma50[sma50.length - 1],
        sma200: sma200[sma200.length - 1],
        adx: adx[adx.length - 1]?.adx,
        prevSma50: sma50[sma50.length - 2],
        prevSma200: sma200[sma200.length - 2],
      };

      spinner.succeed("✅ Current indicators calculated");
      return { currentIndicators, historicalData: alignedData };
    } catch (error) {
      spinner.fail("❌ Failed to calculate indicators");
      throw error;
    }
  }

  alignData(dataByTicker) {
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
        if (maps[ticker].has(date)) {
          dailyData[ticker] = maps[ticker].get(date);
        } else {
          allPresent = false;
          break;
        }
      }

      if (allPresent) alignedData.push(dailyData);
    }

    return alignedData;
  }

  async makeRealTimeDecision(indicators) {
    const spinner = ora("🎯 Analyzing current market conditions...").start();

    try {
      const {
        rsi,
        adx,
        vixClose,
        qqqClose,
        sma50,
        sma200,
        prevSma50,
        volume,
        tqqqClose,
        sqqqClose,
      } = indicators;

      // Check if we're in market hours (if configured)
      if (currentState.aiRules.market_hours_only && !this.isMarketHours()) {
        spinner.succeed("⏰ Outside market hours - HOLD current position");
        return {
          decision: "HOLD",
          reason: "Outside market hours",
          targetSymbol: currentState.position,
          confidence: 1.0,
          indicators,
        };
      }

      // Risk management checks for existing positions
      if (currentState.isLeveragedPosition) {
        const currentPrice =
          currentState.position === CONFIG.longLeveragedEtf
            ? tqqqClose
            : sqqqClose;

        const pnlPercent =
          (currentPrice - currentState.entryPrice) / currentState.entryPrice;

        // Check stop loss
        if (
          pnlPercent <= -currentState.aiRules.risk_management.intraday_stop_loss
        ) {
          spinner.succeed("🛑 SELL signal - Stop loss triggered");
          return {
            decision: "SELL",
            reason: `Stop loss triggered: ${(pnlPercent * 100).toFixed(
              2
            )}% loss`,
            targetSymbol: CONFIG.safeEtf,
            confidence: 1.0,
            indicators,
          };
        }

        // Check profit target
        if (pnlPercent >= currentState.aiRules.risk_management.profit_target) {
          spinner.succeed("💰 SELL signal - Profit target reached");
          return {
            decision: "SELL",
            reason: `Profit target reached: ${(pnlPercent * 100).toFixed(
              2
            )}% gain`,
            targetSymbol: CONFIG.safeEtf,
            confidence: 1.0,
            indicators,
          };
        }

        // Check maximum hold period
        if (
          currentState.daysInPosition >= CONFIG.riskManagement.maxHoldPeriod
        ) {
          spinner.succeed("⏱️ SELL signal - Maximum hold period reached");
          return {
            decision: "SELL",
            reason: "Maximum hold period reached",
            targetSymbol: CONFIG.safeEtf,
            confidence: 0.8,
            indicators,
          };
        }
      }

      let decision = "HOLD";
      let reason = "No clear signal detected";
      let targetSymbol = currentState.position;
      let confidence = 0.5;

      // Check for entry signals
      const isOversold = rsi < CONFIG.baseSignal.rsiOversold;
      const isOverbought = rsi > CONFIG.baseSignal.rsiOverbought;

      if (isOversold && !currentState.isLeveragedPosition) {
        // Check bullish confirmation criteria
        const adxCheck = adx > currentState.aiRules.min_adx_threshold;
        const vixCheck = vixClose < currentState.aiRules.max_vix_threshold;
        const volumeCheck = volume > currentState.aiRules.min_volume_threshold;
        const sma50Check = currentState.aiRules.bullish_confirmation
          .require_price_above_sma50
          ? qqqClose > sma50
          : true;
        const sma200Check = currentState.aiRules.bullish_confirmation
          .require_price_above_sma200
          ? qqqClose > sma200
          : true;
        const risingMaCheck = currentState.aiRules.bullish_confirmation
          .require_rising_sma
          ? sma50 > prevSma50
          : true;

        const bullishChecks = [
          adxCheck,
          vixCheck,
          volumeCheck,
          sma50Check,
          sma200Check,
          risingMaCheck,
        ];
        const passedChecks = bullishChecks.filter(Boolean).length;
        confidence = passedChecks / bullishChecks.length;

        if (passedChecks >= 4) {
          // Require at least 4 out of 6 checks to pass
          decision = "BUY";
          targetSymbol = CONFIG.longLeveragedEtf;
          reason = `Oversold RSI(${rsi.toFixed(
            2
          )}) with ${passedChecks}/6 bullish confirmations`;
        }
      } else if (isOverbought && !currentState.isLeveragedPosition) {
        // Check bearish confirmation criteria
        const adxCheck = adx > currentState.aiRules.min_adx_threshold;
        const vixCheck = vixClose < currentState.aiRules.max_vix_threshold;
        const volumeCheck = volume > currentState.aiRules.min_volume_threshold;
        const sma50Check = currentState.aiRules.bearish_confirmation
          .require_price_below_sma50
          ? qqqClose < sma50
          : true;
        const sma200Check = currentState.aiRules.bearish_confirmation
          .require_price_below_sma200
          ? qqqClose < sma200
          : true;
        const fallingMaCheck = currentState.aiRules.bearish_confirmation
          .require_falling_sma
          ? sma50 < prevSma50
          : true;

        const bearishChecks = [
          adxCheck,
          vixCheck,
          volumeCheck,
          sma50Check,
          sma200Check,
          fallingMaCheck,
        ];
        const passedChecks = bearishChecks.filter(Boolean).length;
        confidence = passedChecks / bearishChecks.length;

        if (passedChecks >= 4) {
          // Require at least 4 out of 6 checks to pass
          decision = "BUY";
          targetSymbol = CONFIG.shortLeveragedEtf;
          reason = `Overbought RSI(${rsi.toFixed(
            2
          )}) with ${passedChecks}/6 bearish confirmations`;
        }
      }

      const decisionEmoji =
        decision === "BUY" ? "🟢" : decision === "SELL" ? "🔴" : "🟡";
      spinner.succeed(`${decisionEmoji} Decision: ${decision} ${targetSymbol}`);

      return {
        decision,
        reason,
        targetSymbol,
        confidence,
        indicators,
      };
    } catch (error) {
      spinner.fail("❌ Failed to make trading decision");
      throw error;
    }
  }

  isMarketHours() {
    const now = new Date();
    const easternTime = new Date(
      now.toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const hour = easternTime.getHours();
    const day = easternTime.getDay();

    // Monday = 1, Friday = 5
    const isWeekday = day >= 1 && day <= 5;
    const isDuringMarketHours = hour >= 9 && hour <= 16; // 9 AM to 4 PM EST

    return isWeekday && isDuringMarketHours;
  }

  async generateDetailedReport(decision, analysis) {
    const spinner = ora("📋 Generating detailed analysis report...").start();

    try {
      const timestamp = new Date().toISOString();
      const { indicators, reason, confidence } = analysis;

      // Get AI analysis of the decision
      const aiAnalysis = await this.getAIAnalysis(decision, indicators, reason);

      const reportData = {
        timestamp,
        decision: decision.decision,
        targetSymbol: decision.targetSymbol,
        reason,
        confidence,
        currentPosition: currentState.position,
        currentEquity: currentState.currentEquity,
        indicators,
        aiAnalysis,
        marketConditions: this.assessMarketConditions(indicators),
        riskAssessment: this.assessRisk(indicators, decision),
      };

      // Generate PDF report
      const pdfPath = await this.createPDFReport(reportData);

      spinner.succeed("✅ Detailed report generated");
      return { reportData, pdfPath };
    } catch (error) {
      spinner.fail("❌ Failed to generate report");
      throw error;
    }
  }

  async getAIAnalysis(decision, indicators, reason) {
    const prompt = `
You are a Senior Trading Analyst providing real-time market analysis.

**Current Trading Decision:** ${decision.decision} ${decision.targetSymbol}
**Reasoning:** ${reason}
**Current Market Data:**
- QQQ Price: $${indicators.qqqClose.toFixed(2)}
- RSI(2): ${indicators.rsi.toFixed(2)}
- ADX: ${indicators.adx.toFixed(2)}
- VIX: ${indicators.vixClose.toFixed(2)}
- Volume: ${indicators.volume.toLocaleString()}
- SMA50: $${indicators.sma50.toFixed(2)}
- SMA200: $${indicators.sma200.toFixed(2)}

Provide a concise analysis (150-200 words) covering:
1. Market condition assessment
2. Risk factors for this decision
3. Expected outlook (bullish/bearish/neutral)
4. Key levels to watch

Keep it professional and actionable.`;

    try {
      const completion = await groqAnalysisClient.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: CONFIG.aiModelName_Analysis,
      });

      return completion.choices[0]?.message?.content || "Analysis unavailable";
    } catch (error) {
      console.error("AI Analysis Error:", error.message);
      return "AI analysis temporarily unavailable";
    }
  }

  assessMarketConditions(indicators) {
    const { rsi, adx, vixClose, qqqClose, sma50, sma200 } = indicators;

    let condition = "NEUTRAL";
    let description = "";

    if (vixClose > 30) {
      condition = "HIGH_VOLATILITY";
      description = "High fear/volatility environment";
    } else if (vixClose < 15) {
      condition = "LOW_VOLATILITY";
      description = "Complacent market conditions";
    } else if (adx > 25) {
      condition = "TRENDING";
      description = "Strong trending market";
    } else if (adx < 20) {
      condition = "SIDEWAYS";
      description = "Choppy, sideways market";
    }

    const trend = qqqClose > sma200 ? "BULLISH" : "BEARISH";
    const shortTrend = qqqClose > sma50 ? "BULLISH" : "BEARISH";

    return {
      condition,
      description,
      longTermTrend: trend,
      shortTermTrend: shortTrend,
      trendStrength: adx,
      fearLevel: vixClose,
    };
  }

  assessRisk(indicators, decision) {
    const { vixClose, adx, volume } = indicators;

    let riskLevel = "MODERATE";
    let factors = [];

    if (vixClose > 35) {
      riskLevel = "HIGH";
      factors.push("Elevated VIX indicates high market stress");
    }

    if (adx < 15) {
      factors.push("Low ADX suggests weak trend, higher whipsaw risk");
    }

    if (volume < currentState.aiRules.min_volume_threshold) {
      factors.push("Below average volume may indicate poor liquidity");
    }

    if (decision.decision === "BUY" && decision.targetSymbol.includes("3x")) {
      factors.push("Leveraged ETF position increases volatility exposure");
    }

    return {
      level: riskLevel,
      factors,
      recommendation:
        factors.length > 2
          ? "Consider reducing position size"
          : "Normal risk parameters",
    };
  }

  async createPDFReport(data) {
    const spinner = ora("📄 Creating PDF report...").start();

    try {
      const {
        timestamp,
        decision,
        reason,
        confidence,
        indicators,
        aiAnalysis,
        marketConditions,
        riskAssessment,
      } = data;

      // Create a simple chart showing recent price action
      const chartBuffer = await this.createPriceChart(indicators);
      const chartBase64 = `data:image/png;base64,${chartBuffer.toString(
        "base64"
      )}`;

      const htmlContent = `
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 30px; color: #333; }
          .header { text-align: center; border-bottom: 3px solid #1e88e5; padding-bottom: 20px; margin-bottom: 30px; }
          .decision-box { background: ${
            decision === "BUY"
              ? "#e8f5e8"
              : decision === "SELL"
              ? "#ffe8e8"
              : "#fff8e1"
          }; 
                          border: 2px solid ${
                            decision === "BUY"
                              ? "#4caf50"
                              : decision === "SELL"
                              ? "#f44336"
                              : "#ff9800"
                          };
                          padding: 20px; margin: 20px 0; border-radius: 8px; }
          .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
          .metric-card { background: #f8f9fa; padding: 15px; border-radius: 6px; text-align: center; }
          .metric-value { font-size: 24px; font-weight: bold; color: #1565c0; }
          .section { margin: 25px 0; }
          .risk-high { color: #d32f2f; }
          .risk-moderate { color: #f57c00; }
          .risk-low { color: #388e3c; }
          h1, h2 { color: #1565c0; }
          pre { background: #f5f5f5; padding: 15px; border-radius: 5px; white-space: pre-wrap; line-height: 1.4; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🎯 Real-Time Trading Decision Report</h1>
          <p><strong>Generated:</strong> ${new Date(
            timestamp
          ).toLocaleString()}</p>
        </div>

        <div class="decision-box">
          <h2>${
            decision === "BUY" ? "🟢" : decision === "SELL" ? "🔴" : "🟡"
          } DECISION: ${decision} ${data.targetSymbol}</h2>
          <p><strong>Reasoning:</strong> ${reason}</p>
          <p><strong>Confidence Level:</strong> ${(confidence * 100).toFixed(
            1
          )}%</p>
          <p><strong>Current Position:</strong> ${data.currentPosition}</p>
        </div>

        <div class="section">
          <h2>📊 Current Market Indicators</h2>
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-value">$${indicators.qqqClose.toFixed(2)}</div>
              <div>QQQ Price</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">${indicators.rsi.toFixed(1)}</div>
              <div>RSI(2)</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">${indicators.vixClose.toFixed(1)}</div>
              <div>VIX</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">${indicators.adx.toFixed(1)}</div>
              <div>ADX</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">$${indicators.sma50.toFixed(2)}</div>
              <div>SMA(50)</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">${(indicators.volume / 1000000).toFixed(
                1
              )}M</div>
              <div>Volume</div>
            </div>
          </div>
        </div>

        <div class="section">
          <h2>🌡️ Market Conditions</h2>
          <p><strong>Condition:</strong> ${marketConditions.condition} - ${
        marketConditions.description
      }</p>
          <p><strong>Long-term Trend:</strong> ${
            marketConditions.longTermTrend
          }</p>
          <p><strong>Short-term Trend:</strong> ${
            marketConditions.shortTermTrend
          }</p>
        </div>

        <div class="section">
          <h2>⚠️ Risk Assessment</h2>
          <p class="risk-${riskAssessment.level.toLowerCase()}"><strong>Risk Level:</strong> ${
        riskAssessment.level
      }</p>
          <ul>
            ${riskAssessment.factors
              .map((factor) => `<li>${factor}</li>`)
              .join("")}
          </ul>
          <p><strong>Recommendation:</strong> ${
            riskAssessment.recommendation
          }</p>
        </div>

        <div class="section">
          <h2>🤖 AI Analysis</h2>
          <pre>${aiAnalysis}</pre>
        </div>

        <div class="section">
          <h2>📈 Price Chart</h2>
          <img src="${chartBase64}" style="width: 100%; max-width: 800px; margin: 20px auto; display: block;">
        </div>

        <div style="margin-top: 50px; text-align: center; color: #666; font-size: 12px;">
          <p>This report is for informational purposes only and does not constitute financial advice.</p>
        </div>
      </body>
      </html>`;

      const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: true,
      });

      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: "networkidle0" });

      const pdfPath = `${CONFIG.outputDir}/trading_decision_${Date.now()}.pdf`;
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: {
          top: "0.5in",
          right: "0.5in",
          bottom: "0.5in",
          left: "0.5in",
        },
      });

      await browser.close();
      spinner.succeed(`✅ PDF report created: ${pdfPath}`);

      return pdfPath;
    } catch (error) {
      spinner.fail("❌ PDF creation failed");
      throw error;
    }
  }

  async createPriceChart(indicators) {
    const width = 800,
      height = 400;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: "white",
    });

    // This is a simplified chart - in practice, you'd want to show recent price history
    const configuration = {
      type: "bar",
      data: {
        labels: ["RSI", "ADX", "VIX"],
        datasets: [
          {
            label: "Current Values",
            data: [indicators.rsi, indicators.adx, indicators.vixClose],
            backgroundColor: [
              "rgba(75, 192, 192, 0.8)",
              "rgba(255, 159, 64, 0.8)",
              "rgba(255, 99, 132, 0.8)",
            ],
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: "Current Market Indicators",
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: "Values",
            },
          },
        },
      },
    };

    return await chartJSNodeCanvas.renderToBuffer(configuration);
  }

  async sendTelegramAlert(decision, reportPath) {
    if (!telegramBot || !process.env.TELEGRAM_CHAT_ID) {
      console.log("⚠️  Telegram not configured, skipping notification");
      return;
    }

    const spinner = ora("📱 Sending Telegram alert...").start();

    try {
      const { decision: action, targetSymbol, reason, confidence } = decision;
      const emoji = action === "BUY" ? "🟢" : action === "SELL" ? "🔴" : "🟡";

      const message = `
${emoji} *TRADING ALERT*

*Decision:* ${action} ${targetSymbol}
*Confidence:* ${(confidence * 100).toFixed(1)}%
*Reason:* ${reason}

*Current Position:* ${currentState.position}
*Portfolio Value:* ${currentState.currentEquity.toLocaleString()}

*Time:* ${new Date().toLocaleString()}

📊 Detailed analysis attached.`;

      // Send text message first
      await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, {
        parse_mode: "Markdown",
      });

      // Send PDF report
      if (reportPath && fs.existsSync(reportPath)) {
        await telegramBot.sendDocument(
          process.env.TELEGRAM_CHAT_ID,
          reportPath,
          {
            caption: "📋 Detailed Trading Analysis Report",
          }
        );
      }

      spinner.succeed("✅ Telegram alert sent successfully");
    } catch (error) {
      spinner.fail("❌ Failed to send Telegram alert");
      console.error("Telegram Error:", error.message);
    }
  }

  async updatePortfolioState(decision) {
    const { decision: action, targetSymbol, indicators } = decision;

    if (action === "BUY" && targetSymbol !== currentState.position) {
      // Execute buy decision
      const currentPrice =
        targetSymbol === CONFIG.longLeveragedEtf
          ? indicators.tqqqClose
          : targetSymbol === CONFIG.shortLeveragedEtf
          ? indicators.sqqqClose
          : indicators.qqqClose;

      // Simulate position update (in real implementation, this would interface with broker API)
      if (currentState.positionShares > 0) {
        // Sell current position first
        const sellPrice =
          currentState.position === CONFIG.longLeveragedEtf
            ? indicators.tqqqClose
            : currentState.position === CONFIG.shortLeveragedEtf
            ? indicators.sqqqClose
            : indicators.qqqClose;

        currentState.currentEquity =
          currentState.positionShares * sellPrice - CONFIG.transactionCost;
      }

      // Buy new position
      currentState.positionShares =
        (currentState.currentEquity - CONFIG.transactionCost) / currentPrice;
      currentState.position = targetSymbol;
      currentState.entryPrice = currentPrice;
      currentState.daysInPosition = 0;
      currentState.isLeveragedPosition =
        targetSymbol === CONFIG.longLeveragedEtf ||
        targetSymbol === CONFIG.shortLeveragedEtf;
    } else if (action === "SELL") {
      // Execute sell decision - move to safe position
      const sellPrice =
        currentState.position === CONFIG.longLeveragedEtf
          ? indicators.tqqqClose
          : currentState.position === CONFIG.shortLeveragedEtf
          ? indicators.sqqqClose
          : indicators.qqqClose;

      currentState.currentEquity =
        currentState.positionShares * sellPrice - CONFIG.transactionCost;

      // Move to safe ETF
      const safePrice = indicators.qqqClose;
      currentState.positionShares =
        (currentState.currentEquity - CONFIG.transactionCost) / safePrice;
      currentState.position = CONFIG.safeEtf;
      currentState.entryPrice = safePrice;
      currentState.daysInPosition = 0;
      currentState.isLeveragedPosition = false;
    }

    // Update days in position for existing positions
    if (action === "HOLD") {
      currentState.daysInPosition++;
    }

    currentState.lastUpdate = new Date().toISOString();
    await this.saveState();
  }

  async saveState() {
    const statePath = `${CONFIG.outputDir}/current_state.json`;
    try {
      await fs.writeJson(statePath, currentState, { spaces: 2 });
    } catch (error) {
      console.error("Failed to save state:", error.message);
    }
  }

  async loadState() {
    const statePath = `${CONFIG.outputDir}/current_state.json`;
    try {
      if (await fs.pathExists(statePath)) {
        const savedState = await fs.readJson(statePath);
        Object.assign(currentState, savedState);
        console.log("📁 Previous state loaded successfully");
      }
    } catch (error) {
      console.log("📁 No previous state found, starting fresh");
    }
  }

  async runRealTimeAnalysis() {
    console.log("\n🔄 Starting real-time analysis cycle...");

    try {
      // 1. Fetch current market data
      const rawData = await this.fetchRealTimeData();

      // 2. Calculate current indicators
      const { currentIndicators } = await this.calculateCurrentIndicators(
        rawData
      );

      // 3. Make trading decision
      const decision = await this.makeRealTimeDecision(currentIndicators);

      // 4. Generate detailed report
      const { reportData, pdfPath } = await this.generateDetailedReport(
        decision,
        {
          indicators: currentIndicators,
          reason: decision.reason,
          confidence: decision.confidence,
        }
      );

      // 5. Update portfolio state
      await this.updatePortfolioState(decision);

      // 6. Send notifications
      await this.sendTelegramAlert(decision, pdfPath);

      // 7. Log summary
      this.logDecisionSummary(decision, currentIndicators);

      console.log("✅ Analysis cycle completed successfully\n");
    } catch (error) {
      console.error("❌ Analysis cycle failed:", error.message);

      // Send error notification
      if (telegramBot && process.env.TELEGRAM_CHAT_ID) {
        try {
          await telegramBot.sendMessage(
            process.env.TELEGRAM_CHAT_ID,
            `🚨 *TRADING SYSTEM ERROR*\n\nError: ${
              error.message
            }\nTime: ${new Date().toLocaleString()}`,
            { parse_mode: "Markdown" }
          );
        } catch (telegramError) {
          console.error(
            "Failed to send error notification:",
            telegramError.message
          );
        }
      }
    }
  }

  logDecisionSummary(decision, indicators) {
    console.log("--- 📊 DECISION SUMMARY ---");
    console.log(`Time: ${new Date().toLocaleString()}`);
    console.log(`Decision: ${decision.decision} ${decision.targetSymbol}`);
    console.log(`Reason: ${decision.reason}`);
    console.log(`Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
    console.log(`Current Position: ${currentState.position}`);
    console.log(
      `Portfolio Value: ${currentState.currentEquity.toLocaleString()}`
    );
    console.log(
      `QQQ: ${indicators.qqqClose.toFixed(2)} | RSI: ${indicators.rsi.toFixed(
        1
      )} | VIX: ${indicators.vixClose.toFixed(1)}`
    );
    console.log("-------------------------\n");
  }

  startScheduledTrading() {
    console.log(
      `🕒 Starting scheduled trading system (${CONFIG.tradingSchedule})`
    );

    this.cronJob = new cron.CronJob(
      CONFIG.tradingSchedule,
      () => this.runRealTimeAnalysis(),
      null,
      true,
      CONFIG.timezone
    );

    console.log("✅ Scheduled trading system is now active");
    console.log("📅 Next run:", this.cronJob.nextDate().toString());
  }

  async startManualTrading() {
    console.log("🎮 Starting manual trading mode");
    console.log("Press 'r' + Enter to run analysis, 'q' + Enter to quit\n");

    process.stdin.setEncoding("utf8");
    process.stdin.on("readable", () => {
      const chunk = process.stdin.read();
      if (chunk !== null) {
        const command = chunk.trim().toLowerCase();

        if (command === "r") {
          this.runRealTimeAnalysis();
        } else if (command === "q") {
          console.log("👋 Shutting down manual trading mode");
          process.exit(0);
        } else if (command === "h") {
          console.log("Commands: 'r' = run analysis, 'q' = quit, 'h' = help");
        }
      }
    });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log("🛑 Scheduled trading stopped");
    }
    this.isRunning = false;
  }
}

// --- MAIN EXECUTION ---
async function main() {
  console.log("🚀 Real-Time Trading Decision System");
  console.log("====================================");

  const tradingSystem = new RealTimeTradingSystem();

  try {
    // Initialize the system
    const initialized = await tradingSystem.initialize();
    if (!initialized) {
      process.exit(1);
    }

    // Check command line arguments for mode selection
    const args = process.argv.slice(2);
    const mode = args[0] || "manual";

    if (mode === "scheduled") {
      // Start scheduled mode
      tradingSystem.startScheduledTrading();

      // Keep the process alive
      process.on("SIGINT", () => {
        console.log("\n🛑 Shutting down scheduled trading system...");
        tradingSystem.stop();
        process.exit(0);
      });

      // Run initial analysis
      await tradingSystem.runRealTimeAnalysis();
    } else if (mode === "once") {
      // Run analysis once and exit
      await tradingSystem.runRealTimeAnalysis();
      console.log("✅ Single analysis completed");
    } else {
      // Default to manual mode
      await tradingSystem.startManualTrading();
    }
  } catch (error) {
    console.error("💥 System error:", error.message);
    process.exit(1);
  }
}

// Export for potential use as module
module.exports = { RealTimeTradingSystem, CONFIG };

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
