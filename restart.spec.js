// tests/restart.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

async function sendTG(result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const msg = [`🎮 FreezeHost 拉起报告`, `🕐 时间: ${nowStr()}`, `========================`, result].join('\n');
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, resolve);
        req.on('error', resolve);
        req.write(body); req.end();
    });
}

/**
 * 核心：处理授权页
 */
async function handleOAuthPage(page) {
    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;
        try {
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")').last();
            if (await authBtn.isVisible()) {
                await authBtn.click();
                await page.waitForTimeout(2000);
            }
        } catch { break; }
    }
}

test('FreezeHost 自动检查并拉起服务器', async () => {
    if (tokens.length === 0) throw new Error('❌ 缺少 DISCORD_TOKEN');

    const browser = await chromium.launch({ headless: true });
    let allSummary = [];

    try {
        for (let tIndex = 0; tIndex < tokens.length; tIndex++) {
            let currentToken = tokens[tIndex];
            let customName = null;
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) { customName = match[1].trim(); currentToken = match[2].trim(); }

            let accountLabel = customName ? `👤 ${customName}` : `👤 账号 ${tIndex + 1}`;
            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);

            try {
                // 1. Token 注入登录
                await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                await page.evaluate((token) => {
                    localStorage.setItem('token', `"${token}"`);
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.token = `"${token}"`;
                }, currentToken);

                // 2. 登录 FreezeHost
                await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
                await page.click('span:has-text("Login with Discord")');

                const confirmBtn = page.locator('button#confirm-login');
                if (await confirmBtn.isVisible({ timeout: 5000 })) await confirmBtn.click();

                // 3. 处理 OAuth
                try {
                    await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 8000 });
                    await handleOAuthPage(page);
                } catch {}

                await page.waitForURL(/dashboard/, { timeout: 20000 });
                console.log(`✅ ${accountLabel} 登录成功`);

                // 4. 获取所有服务器控制台链接
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
                });

                allSummary.push(`${accountLabel}`);

                for (let i = 0; i < serverUrls.length; i++) {
                    const sUrl = serverUrls[i];
                    await page.goto(sUrl, { waitUntil: 'networkidle' });
                    await page.waitForTimeout(5000); // 等待状态加载

                    const serverName = await page.title().then(t => t.replace('Dashboard - ', ''));
                    
                    // 核心逻辑：识别按钮并操作
                    const wakeUpBtn = page.locator('button:has-text("WAKE UP SERVER")');
                    const startBtn = page.locator('button:has-text("Start")').first();
                    const restartBtn = page.locator('button:has-text("Restart")').first();

                    let actionTaken = "";

                    if (await wakeUpBtn.isVisible()) {
                        await wakeUpBtn.click();
                        actionTaken = "🌙 成功唤醒 (Wake Up)";
                    } else if (await startBtn.isVisible() && await startBtn.isEnabled()) {
                        await startBtn.click();
                        actionTaken = "🚀 成功启动 (Start)";
                    } else if (await restartBtn.isVisible()) {
                        // 如果已经在运行，执行一次重启确保活跃
                        await restartBtn.click();
                        const confirmRestart = page.locator('button:has-text("Confirm")');
                        if (await confirmRestart.isVisible({timeout: 3000})) await confirmRestart.click();
                        actionTaken = "🔄 运行中，已执行重启";
                    } else {
                        actionTaken = "❓ 未识别到操作按钮";
                    }

                    console.log(`  📦 ${serverName}: ${actionTaken}`);
                    allSummary.push(`  ├─ ${serverName}\n  └─ 状态: ${actionTaken}`);
                }
            } catch (err) {
                allSummary.push(`  ❌ 处理失败: ${err.message.slice(0, 30)}`);
            } finally {
                await context.close();
            }
        }

        const report = allSummary.join('\n');
        console.log(report);
        await sendTG(report);

    } finally {
        await browser.close();
    }
});
