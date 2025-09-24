const yahooFinance = require("yahoo-finance2").default;
const { SMA, RSI, ADX } = require("technicalindicators");
const Groq = require("groq-sdk");
const dotenv = require("dotenv");
const fs = require("fs-extra");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const moment = require("moment");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
const puppeteer = require("puppeteer");

dotenv.config();

const CONFIG = {
  signalEtf: "QQQ",
  volatilityTicker: "^VIX",
  longEtf: "TQQQ",
  shortEtf: "SQQQ",
  lookbackPeriod: 252,
  baseSignal: { rsiPeriod: 2, rsiOversold: 10, rsiOverbought: 90 },
  initialCapital: 100000, // Added initial capital
  riskPerTrade: 0.02, // 2% risk per trade
  maxPositionSize: 0.25, // Maximum 25% of capital per position
  stopLossPercent: 0.05, // 5% stop loss
  aiModelName: process.env.AI_MODEL_NAME_1 || "openai/gpt-oss-120b",
  pdfRetentionDays: parseInt(process.env.PDF_RETENTION_DAYS || "30", 10), // retention in days
};

// Initialize Groq client
const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY_1 });

const LOG_DIR = path.join(__dirname, "logs");
const TRADE_HISTORY_FILE = path.join(LOG_DIR, "trade_history.json");
const MARKET_DATA_LOG_FILE = path.join(LOG_DIR, "market_data_log.csv");

async function ensureLogDir() {
  await fs.ensureDir(LOG_DIR);
  // Ensure trade history file exists (initial empty array)
  if (!(await fs.pathExists(TRADE_HISTORY_FILE))) {
    await fs.writeJson(TRADE_HISTORY_FILE, [], { spaces: 2 });
    console.log(`🔧 Initialized trade history file: ${TRADE_HISTORY_FILE}`);
  }
  // Ensure raw AI logs exist
  const rawAiFile = path.join(LOG_DIR, "raw_ai_responses.log");
  if (!(await fs.pathExists(rawAiFile))) await fs.writeFile(rawAiFile, "");
}

// Robust JSON extraction from model text
function parseJsonFromString(str) {
  if (!str || typeof str !== "string") return null;
  // Try direct parse first
  try {
    return JSON.parse(str);
  } catch (e) {
    // Attempt to extract the first JSON object substring
    const m = str.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

async function appendTradeHistory(entry) {
  await ensureLogDir();
  let history = [];
  if (await fs.pathExists(TRADE_HISTORY_FILE)) {
    try {
      history = await fs.readJson(TRADE_HISTORY_FILE);
    } catch (e) {
      history = [];
    }
  }
  history.push(entry);
  await fs.writeJson(TRADE_HISTORY_FILE, history, { spaces: 2 });
  console.log(`🔒 Trade history updated: ${TRADE_HISTORY_FILE}`);
}

async function appendMarketDataLog({ timestamp, qqq, tqqq, sqqq }) {
  await ensureLogDir();
  const header = "Timestamp,QQQ_Price,TQQQ_Price,SQQQ_Price\n";
  const row = `${timestamp},${qqq},${tqqq},${sqqq}\n`;
  if (!(await fs.pathExists(MARKET_DATA_LOG_FILE))) {
    await fs.writeFile(MARKET_DATA_LOG_FILE, header + row);
    console.log(`🗒️ Market data log created: ${MARKET_DATA_LOG_FILE}`);
  } else {
    await fs.appendFile(MARKET_DATA_LOG_FILE, row);
    console.log(`🗒️ Market data appended: ${MARKET_DATA_LOG_FILE}`);
  }
}

async function getRecentTradeSummary(n = 5) {
  if (!(await fs.pathExists(TRADE_HISTORY_FILE))) return "No prior trades.";
  const history = await fs.readJson(TRADE_HISTORY_FILE);
  const recent = history.slice(-n);
  if (recent.length === 0) return "No prior trades.";
  let wins = 0,
    losses = 0,
    bullish = 0,
    bearish = 0;
  recent.forEach((t) => {
    if (t.decision === "BUY") {
      if (t.targetEtf === CONFIG.longEtf) bullish++;
      if (t.targetEtf === CONFIG.shortEtf) bearish++;
      if (t.outcome === "WIN") wins++;
      if (t.outcome === "LOSS") losses++;
    }
  });
  return `Last ${
    recent.length
  } trades: ${wins} wins, ${losses} losses. Recent bias: ${
    bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral"
  }.`;
}

function formatNum(v, decimals = 2) {
  return typeof v === "number" && isFinite(v) ? v.toFixed(decimals) : "N/A";
}

async function sendTelegramUpdate(finalDecision, aiAnalysis, pdfPath = null) {
  const token = process.env.TELEGRAM_API_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(
      "⚠️ Telegram credentials missing - skipping Telegram notification."
    );
    return;
  }
  try {
    const bot = new TelegramBot(token);
    const m = finalDecision || {};
    const metrics = m.metrics || {};

    let msg = `*AI-Hybrid Trading Update*\n\n`;
    msg += `*Action:* ${m.decision || "N/A"} ${m.targetEtf || ""}\n`;
    msg += `*Reason:* ${m.reason || "N/A"}\n`;
    if (m.decision === "BUY") {
      msg += `*Shares:* ${formatNum(m.shares, 0)}\n`;
      msg += `*Position Value:* $${formatNum(m.positionValue)}\n`;
      msg += `*Stop Loss:* $${formatNum(m.stopLossPrice)}\n`;
    }
    if (aiAnalysis) {
      msg += `*AI Risk Level:* ${aiAnalysis.riskLevel || "N/A"}\n`;
      msg += `*AI Explanation:* ${aiAnalysis.explanation || "N/A"}\n`;
    }
    msg += `\n*Market Metrics:*\n`;
    msg += `QQQ: $${formatNum(metrics.currentPrice)}, RSI: ${formatNum(
      metrics.currentRsi
    )}, VIX: ${formatNum(metrics.vixClose)}\n`;
    msg += `TQQQ: $${formatNum(metrics.tqqqPrice)}, SQQQ: $${formatNum(
      metrics.sqqqPrice
    )}`;

    const res = await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    console.log(`✅ Telegram message sent (message_id=${res.message_id}).`);

    if (pdfPath) {
      if (await fs.pathExists(pdfPath)) {
        const stream = fs.createReadStream(pdfPath);
        const docRes = await bot.sendDocument(
          chatId,
          stream,
          {},
          { filename: path.basename(pdfPath) }
        );
        console.log(`📎 Telegram PDF sent (message_id=${docRes.message_id}).`);
      } else {
        console.log(`⚠️ PDF not found, skipping attachment: ${pdfPath}`);
      }
    }
  } catch (err) {
    console.error("Telegram Error:", err.message);
  }
}

async function getAIAnalysis(marketData) {
  // include historical context and market regime in the prompt
  const recentSummary = await getRecentTradeSummary(5);
  const marketRegime = marketData.currentSma200
    ? marketData.currentPrice > marketData.currentSma200
      ? "Bullish"
      : "Bearish"
    : "Unknown";

  const prompt = `
You are a Senior Quantitative Analyst providing real-time market analysis.

Historical Context:
- Recent Trade Summary: ${recentSummary}
- Market Regime: ${marketRegime} (Price ${
    marketRegime === "Bullish" ? ">" : "<"
  } 200-day SMA)
- Note: This context is for your reference to identify patterns in your own decision-making.

Current Market Data:
- QQQ Price: $${marketData.currentPrice}
- RSI(2): ${marketData.currentRsi}
- ADX: ${marketData.currentAdx}
- VIX: ${marketData.vixClose}
- SMA50: $${marketData.currentSma50}
- SMA200: $${marketData.currentSma200 || "N/A"}
- TQQQ: $${marketData.tqqqPrice || "N/A"}
- SQQQ: $${marketData.sqqqPrice || "N/A"}

Technical Signals:
${marketData.technicalDecision}
${marketData.reason}

Provide a concise trading recommendation (max 120 words) that includes:
1. Agreement/disagreement with technical signals
2. Risk assessment (High/Medium/Low)
3. Suggested position size adjustment (0-100% of base recommendation)
4. Key levels to watch

Format: JSON only, no explanation
Example:
{
    "agreement": true,
    "riskLevel": "MEDIUM",
    "positionSizeAdjustment": 0.75,
    "keyLevels": { "support": 350, "resistance": 380 },
    "explanation": "Concise reason for the decision"
}`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: CONFIG.aiModelName,
    });

    const response = completion.choices[0]?.message?.content || "{}";
    // Log raw response for debugging
    const rawLogFile = path.join(LOG_DIR, "raw_ai_responses.log");
    try {
      await fs.appendFile(
        rawLogFile,
        `\n--- ${new Date().toISOString()} ---\n` + response + "\n"
      );
    } catch (e) {}

    const parsed = parseJsonFromString(response);
    if (!parsed) {
      console.error(
        "AI Analysis Error: failed to parse JSON from model response - falling back to conservative default"
      );
      // Log fallback
      const parsedLogFile = path.join(LOG_DIR, "parsed_ai_responses.log");
      const fallback = {
        agreement: false,
        riskLevel: "HIGH",
        positionSizeAdjustment: 0,
        keyLevels: {},
        explanation: "AI parse failed; defaulting to conservative stance.",
      };
      try {
        await fs.appendFile(
          parsedLogFile,
          `\n--- ${new Date().toISOString()} ---\n` +
            JSON.stringify(fallback) +
            "\n"
        );
      } catch (e) {}
      return fallback;
    }
    // Log parsed
    try {
      await fs.appendFile(
        path.join(LOG_DIR, "parsed_ai_responses.log"),
        `\n--- ${new Date().toISOString()} ---\n` +
          JSON.stringify(parsed) +
          "\n"
      );
    } catch (e) {}
    return parsed;
  } catch (error) {
    console.error("AI Analysis Error:", error.message);
    return {
      agreement: false,
      riskLevel: "HIGH",
      positionSizeAdjustment: 0,
      keyLevels: {},
      explanation: "AI call failed; defaulting to conservative stance.",
    };
  }
}

function calculatePositionSize(
  price,
  stopLossPercent,
  availableCapital,
  riskAmount,
  aiAdjustment = 1
) {
  const stopLossAmount = price * stopLossPercent;
  const adjustedRiskAmount = riskAmount * aiAdjustment;
  const maxShares = Math.floor(adjustedRiskAmount / stopLossAmount);
  const positionValue = maxShares * price;

  // Ensure position size doesn't exceed max allowed
  const maxAllowedValue = availableCapital * CONFIG.maxPositionSize;
  if (positionValue > maxAllowedValue) {
    return Math.floor(maxAllowedValue / price);
  }

  return maxShares;
}

async function readMarketCsv() {
  if (!(await fs.pathExists(MARKET_DATA_LOG_FILE))) return [];
  const txt = await fs.readFile(MARKET_DATA_LOG_FILE, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const header = lines
    .shift()
    .split(",")
    .map((h) => h.trim());
  return lines.map((line) => {
    const parts = line.split(",");
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = parts[i];
    });
    return {
      timestamp: obj.Timestamp,
      qqq: parseFloat(obj.QQQ_Price),
      tqqq: parseFloat(obj.TQQ_Price),
      sqqq: parseFloat(obj.SQQ_Price),
    };
  });
}

async function generateChartBase64(marketData, tradeHistory) {
  const width = 1200,
    height = 500;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "white",
  });

  const labels = marketData.map((d) => d.timestamp);
  const qqq = marketData.map((d) => d.qqq);
  const tqqq = marketData.map((d) => d.tqqq);
  const sqqq = marketData.map((d) => d.sqqq);

  // Prepare trade markers array aligned with labels
  const labelsDates = labels.map((l) => moment(l).format("YYYY-MM-DD"));
  const entryData = new Array(labels.length).fill(null);
  const pointBg = new Array(labels.length).fill("rgba(0,0,0,0)");

  const colorMap = { TQQQ: "#1b9e77", SQQQ: "#d95f02", QQQ: "#2b7bba" };

  (tradeHistory || []).forEach((tr) => {
    const trDate = moment(tr.timestamp).format("YYYY-MM-DD");
    labelsDates.forEach((d, idx) => {
      if (d === trDate) {
        entryData[idx] = tr.entryPrice || null;
        pointBg[idx] = colorMap[tr.targetEtf] || "#000000";
      }
    });
  });

  const datasets = [
    {
      label: "QQQ",
      data: qqq,
      borderColor: "#2b7bba",
      tension: 0.1,
      fill: false,
    },
    {
      label: "TQQQ",
      data: tqqq,
      borderColor: "#1b9e77",
      tension: 0.1,
      fill: false,
    },
    {
      label: "SQQQ",
      data: sqqq,
      borderColor: "#d95f02",
      tension: 0.1,
      fill: false,
    },
  ];

  // Add entry markers as a scatter-like dataset
  const tradeIndices = [];
  const tradeColors = [];
  entryData.forEach((v, idx) => {
    if (v !== null) {
      tradeIndices.push(idx);
      tradeColors.push(pointBg[idx]);
    }
  });

  if (entryData.some((v) => v !== null)) {
    datasets.push({
      label: "Trade Entries",
      data: entryData,
      borderColor: "#00000000",
      backgroundColor: pointBg,
      pointRadius: 6,
      pointStyle: "triangle",
      showLine: false,
    });
  }

  // Plugin to draw vertical lines at tradeIndices
  const tradeLinesPlugin = {
    id: "tradeLines",
    afterDatasetsDraw: (chart, args, options) => {
      const cfg = chart.options.plugins.tradeLines || {};
      const indices = cfg.indices || [];
      const colors = cfg.colors || [];
      const ctx = chart.ctx;
      const chartArea = chart.chartArea;
      const xScale = chart.scales.x;
      if (!indices.length) return;
      ctx.save();
      indices.forEach((idx, i) => {
        const x = xScale.getPixelForValue(idx);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = colors[i] || "rgba(0,0,0,0.4)";
        ctx.setLineDash([6, 4]);
        ctx.stroke();
      });
      ctx.restore();
    },
  };

  const config = {
    type: "line",
    data: { labels, datasets },
    plugins: [tradeLinesPlugin],
    options: {
      plugins: {
        legend: { position: "top" },
        tradeLines: { indices: tradeIndices, colors: tradeColors },
      },
      scales: { x: { display: true }, y: { display: true } },
    },
  };

  const image = await chartJSNodeCanvas.renderToBuffer(config);
  return image.toString("base64");
}

async function generateTradePdf(finalDecision) {
  await fs.ensureDir(path.join(__dirname, "Trades"));
  const trades = await ((await fs.pathExists(TRADE_HISTORY_FILE))
    ? fs.readJson(TRADE_HISTORY_FILE)
    : []);
  const marketData = await readMarketCsv();

  // Date and EST time for filename
  const dateStr = moment().format("DD-MM-YYYY");
  // build EST time hh-mm-AM/PM
  const dtParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date());
  const hour = dtParts.find((p) => p.type === "hour")?.value || "00";
  const minute = dtParts.find((p) => p.type === "minute")?.value || "00";
  const dayPeriod = dtParts.find((p) => p.type === "dayPeriod")?.value || "AM";
  const timeForFile = `${hour}-${minute}-${dayPeriod}-EST`;

  const filename = path.join(
    __dirname,
    "Trades",
    `Trade - ${dateStr} - ${timeForFile}.pdf`
  );

  let chartBase64 = null;
  if (marketData.length > 0) {
    chartBase64 = await generateChartBase64(marketData.slice(-200), trades);
  }

  const explanation =
    finalDecision.decision === "BUY"
      ? `<p>The agent entered a <strong>${finalDecision.decision} ${finalDecision.targetEtf}</strong> position based on the technical signal and AI analysis at ${finalDecision.timestamp}.</p>`
      : `<p>No BUY executed this run. This report captures the market context and any past trades for review.</p>`;

  const tradesTable =
    trades.length > 0
      ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Timestamp</th><th>Symbol</th><th>Shares</th><th>Entry Price</th><th>Technical Reason</th><th>AI Justification</th><th>Risk</th><th>Outcome</th></tr></thead>
      <tbody>
        ${trades
          .map(
            (t) => `
          <tr>
            <td>${t.timestamp}</td>
            <td>${t.targetEtf}</td>
            <td>${t.shares ?? ""}</td>
            <td>$${t.entryPrice ?? ""}</td>
            <td>${t.technicalReason ?? ""}</td>
            <td>${t.aiJustification ?? ""}</td>
            <td>${t.riskLevel ?? ""}</td>
            <td>${t.outcome ?? ""}</td>
          </tr>
        `
          )
          .join("\n")}
      </tbody>
    </table>`
      : "<p>No historical trades recorded yet.</p>";

  // AI justifications section
  const aiSection =
    trades.length > 0
      ? `<div class="section"><h2>AI Justifications</h2>${trades
          .map(
            (t) =>
              `<p><strong>${t.timestamp} - ${t.targetEtf}:</strong> ${
                t.aiJustification || "N/A"
              }</p>`
          )
          .join("")}</div>`
      : "";

  const html = `
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Trade - ${moment().format("DD/MM/YYYY")} ${timeForFile}</title>
    <style>
      body { font-family: -apple-system, Roboto, Arial; margin: 20px; color: #222; }
      h1 { color: #1a237e; }
      table { font-size: 12px; }
      .chart { text-align: center; margin: 20px 0; }
      .section { margin-bottom: 24px; }
      .ai-just { background:#f7f7f9; padding:10px; border-radius:6px; }
    </style>
  </head>
  <body>
    <h1>Trade Report — ${moment().format("DD/MM/YYYY")} ${timeForFile}</h1>
    <div class="section">
      <h2>Trade Explanation</h2>
      ${explanation}
      <p><strong>Details:</strong> Action: ${finalDecision.decision} ${
    finalDecision.targetEtf
  } — Shares: ${finalDecision.shares || "N/A"} — Entry Price: $${
    finalDecision.metrics?.currentPrice ?? "N/A"
  }</p>
    </div>

    <div class="section">
      <h2>Previous Trades</h2>
      ${tradesTable}
    </div>

    ${aiSection}

    <div class="section">
      <h2>Price Chart (QQQ, TQQQ, SQQQ)</h2>
      <div class="chart">
        ${
          chartBase64
            ? `<img src="data:image/png;base64,${chartBase64}" style="max-width:100%; height:auto;"/>`
            : "<p>No market log data available to render chart.</p>"
        }
      </div>
    </div>

  </body>
  </html>
  `;

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: filename,
    format: "A4",
    printBackground: true,
    margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
  });
  await browser.close();

  console.log(`✅ Trade PDF created: ${filename}`);
  return filename;
}

async function cleanOldPdfs() {
  try {
    const dir = path.join(__dirname, "Trades");
    if (!(await fs.pathExists(dir))) return;
    const files = await fs.readdir(dir);
    const now = Date.now();
    const retentionMs = CONFIG.pdfRetentionDays * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > retentionMs) {
        await fs.remove(full);
        console.log(`🧹 Removed old PDF: ${full}`);
      }
    }
  } catch (e) {
    console.error("PDF cleanup error:", e.message);
  }
}

async function getQuickTradeDecision() {
  try {
    // Ensure logs directory exists immediately so creation is visible
    await ensureLogDir();
    console.log(`📁 Ensured logs directory exists at: ${LOG_DIR}`);

    // Fetch current market data
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - CONFIG.lookbackPeriod);

    // include TQQQ and SQQQ in tickers
    const tickers = [
      CONFIG.signalEtf,
      CONFIG.volatilityTicker,
      CONFIG.longEtf,
      CONFIG.shortEtf,
    ];
    const data = {};

    for (const ticker of tickers) {
      const result = await yahooFinance.chart(ticker, {
        period1: startDate.toISOString().split("T")[0],
        period2: endDate.toISOString().split("T")[0],
        interval: "1d",
      });
      data[ticker] = result.quotes;
    }

    // Calculate indicators
    const qqqData = data[CONFIG.signalEtf];
    const qqqCloses = qqqData.map((d) => d.close);
    const vixClose =
      data[CONFIG.volatilityTicker][data[CONFIG.volatilityTicker].length - 1]
        .close;

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
      close: qqqCloses,
    });

    // Get latest values
    const currentRsi = rsi[rsi.length - 1];
    const currentAdx = adx[adx.length - 1]?.adx || 0;
    const currentPrice = qqqCloses[qqqCloses.length - 1];
    const currentSma50 = sma50[sma50.length - 1];
    const currentSma200 = sma200[sma200.length - 1];
    const tqqqPrice =
      data[CONFIG.longEtf][data[CONFIG.longEtf].length - 1].close;
    const sqqqPrice =
      data[CONFIG.shortEtf][data[CONFIG.shortEtf].length - 1].close;

    // Make decision
    let decision = "HOLD";
    let reason = "";
    let targetEtf = CONFIG.signalEtf;

    if (currentRsi < CONFIG.baseSignal.rsiOversold) {
      decision = "BUY";
      targetEtf = CONFIG.longEtf;
      reason = `RSI(${currentRsi.toFixed(
        2
      )}) deeply oversold, strong reversal potential`;
    } else if (currentRsi > CONFIG.baseSignal.rsiOverbought) {
      decision = "BUY";
      targetEtf = CONFIG.shortEtf;
      reason = `RSI(${currentRsi.toFixed(
        2
      )}) heavily overbought, expecting pullback`;
    } else {
      reason = `RSI(${currentRsi.toFixed(2)}) in neutral zone, no clear signal`;
    }

    const technicalDecision = { decision, targetEtf, reason };

    // Get AI analysis with historical context
    const aiAnalysis = await getAIAnalysis({
      currentPrice,
      currentRsi,
      currentAdx,
      vixClose,
      currentSma50,
      currentSma200,
      technicalDecision: decision,
      reason,
      tqqqPrice,
      sqqqPrice,
    });

    // Dynamic risk model based on AI riskLevel
    let riskAmount = CONFIG.initialCapital * CONFIG.riskPerTrade;
    if (aiAnalysis) {
      if (aiAnalysis.riskLevel === "MEDIUM")
        riskAmount = CONFIG.initialCapital * 0.01;
      if (aiAnalysis.riskLevel === "HIGH")
        riskAmount = CONFIG.initialCapital * 0.005;
    }

    const aiAdjustment = aiAnalysis ? aiAnalysis.positionSizeAdjustment : 1;
    let shares = 0;
    let positionValue = 0;

    if (decision === "BUY" && (!aiAnalysis || aiAnalysis.agreement)) {
      shares = calculatePositionSize(
        currentPrice,
        CONFIG.stopLossPercent,
        CONFIG.initialCapital,
        riskAmount,
        aiAdjustment
      );
      positionValue = shares * currentPrice;
    } else if (decision === "BUY" && aiAnalysis && !aiAnalysis.agreement) {
      decision = "HOLD";
      reason = `AI Override: ${aiAnalysis.explanation}`;
    }

    // Final decision object
    const finalDecision = {
      decision,
      targetEtf,
      reason,
      shares,
      positionValue,
      metrics: {
        currentPrice,
        currentRsi,
        currentAdx,
        vixClose,
        currentSma50,
        currentSma200,
        tqqqPrice,
        sqqqPrice,
      },
      stopLossPrice: currentPrice * (1 - CONFIG.stopLossPercent),
      timestamp: new Date().toISOString(),
    };

    // Console output (enhanced)
    console.log("\n🎯 AI-Hybrid Trading Decision");
    console.log("===========================");
    console.log(`Time: ${new Date().toLocaleString()}`);
    console.log("\nTechnical Analysis:");
    console.log(
      `- Signal: ${technicalDecision.decision} ${technicalDecision.targetEtf}`
    );
    console.log(`- Reason: ${technicalDecision.reason}\n`);

    if (aiAnalysis) {
      console.log("AI Analysis:");
      console.log(
        `- Agrees with Technical: ${aiAnalysis.agreement ? "Yes" : "No"}`
      );
      console.log(`- Risk Level: ${aiAnalysis.riskLevel}`);
      console.log(
        `- Position Size Adjustment: ${formatNum(
          (aiAnalysis.positionSizeAdjustment || 0) * 100,
          0
        )}%`
      );
      console.log(
        `- Key Levels: Support $${
          aiAnalysis.keyLevels?.support || "N/A"
        }, Resistance $${aiAnalysis.keyLevels?.resistance || "N/A"}`
      );
      console.log(`- AI Insight: ${aiAnalysis.explanation || "N/A"}\n`);
    }

    console.log("Final Decision:");
    console.log(`- Action: ${decision} ${targetEtf}`);
    console.log(`- Reason: ${reason}\n`);

    if (decision === "BUY") {
      console.log("Position Sizing:");
      console.log(`- Recommended Shares: ${formatNum(shares, 0)}`);
      console.log(`- Position Value: $${formatNum(positionValue)}`);
      console.log(
        `- % of Capital: ${formatNum(
          (positionValue / CONFIG.initialCapital) * 100
        )}%`
      );
      console.log(
        `- Stop Loss Price: $${formatNum(
          currentPrice * (1 - CONFIG.stopLossPercent)
        )}`
      );
      console.log(`- Risk Amount: $${formatNum(riskAmount)}\n`);
    }

    console.log("Current Market Metrics:");
    console.log(`- QQQ Price: $${formatNum(currentPrice)}`);
    console.log(`- TQQQ Price: $${formatNum(tqqqPrice)}`);
    console.log(`- SQQQ Price: $${formatNum(sqqqPrice)}`);
    console.log(`- RSI(2): ${formatNum(currentRsi)}`);
    console.log(`- ADX: ${formatNum(currentAdx)}`);
    console.log(`- VIX: ${formatNum(vixClose)}`);
    console.log(`- SMA50: $${formatNum(currentSma50)}`);
    console.log(`- SMA200: $${formatNum(currentSma200)}\n`);

    // Append market data log
    await appendMarketDataLog({
      timestamp: finalDecision.timestamp,
      qqq: currentPrice,
      tqqq: tqqqPrice,
      sqqq: sqqqPrice,
    });

    // Append trade history for BUY decisions
    if (finalDecision.decision === "BUY") {
      await appendTradeHistory({
        timestamp: finalDecision.timestamp,
        targetEtf: finalDecision.targetEtf,
        shares: finalDecision.shares,
        entryPrice: currentPrice,
        technicalReason: reason,
        aiJustification: aiAnalysis?.explanation || "",
        riskLevel: aiAnalysis?.riskLevel || "UNKNOWN",
        decision: "BUY",
        outcome: null,
      });
    }

    // Generate PDF report for every run
    const pdfFilename = await generateTradePdf(finalDecision);

    // Send Telegram update (attach PDF if creds present)
    await sendTelegramUpdate(finalDecision, aiAnalysis, pdfFilename);

    // Run PDF retention cleanup
    await cleanOldPdfs();

    // Return the complete decision object
    return {
      technical: technicalDecision,
      ai: aiAnalysis,
      finalDecision,
    };
  } catch (error) {
    console.error("Error:", error.message);
    return null;
  }
}

// Run if called directly
if (require.main === module) {
  getQuickTradeDecision();
}

module.exports = { getQuickTradeDecision };
