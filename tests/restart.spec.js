const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

// 配置信息
const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
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

// 处理 Discord 授权确认页
async function handleOAuthPage(page) {
    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;
        try {
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")').last();
            if (await authBtn.isVisible({ timeout: 5000 })) {
                await authBtn.click();
                await page.waitForTimeout(3000);
            }
        } catch { break; }
    }
}

test('FreezeHost 自动拉起与重启', async () => {
    if (tokens.length === 0) throw new Error('❌ 未配置 DISCORD_TOKEN');

    const browser = await chromium.launch({ headless: true });
    let allSummary = [];

    for (let tIndex = 0; tIndex < tokens.length; tIndex++) {
        let currentToken = tokens[tIndex];
        let customName = `账号 ${tIndex + 1}`;

        if (currentToken.includes('#')) {
            [customName, currentToken] = currentToken.split('#');
        }

        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);

        try {
            console.log(`🚀 正在处理: ${customName}`);

            // 1. 注入 Token (修复 ReferenceError 的核心逻辑)
            await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
            
            await page.evaluate(async (token) => {
                // 定义轮询检查函数
                const checkStorage = () => {
                    return new Promise((resolve) => {
                        const interval = setInterval(() => {
                            if (typeof localStorage !== 'undefined') {
                                clearInterval(interval);
                                resolve();
                            }
                        }, 100);
                    });
                };
                await checkStorage();
                
                // 注入 Token 到 localStorage
                localStorage.setItem('token', `"${token}"`);
                // 辅助注入：部分环境下 Discord 校验 iframe 存储
                const iframe = document.createElement('iframe');
                document.body.appendChild(iframe);
                if (iframe.contentWindow) {
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }
            }, currentToken);

            // 2. 验证登录并前往 FreezeHost
            await page.goto('https://discord.com/channels/@me', { waitUntil: 'networkidle' });
            if (page.url().includes('login')) throw new Error('Token 已失效');

            await page.goto('https://free.freezehost.pro/dashboard', { waitUntil: 'networkidle' });

            // 3. 处理登录/授权确认
            if (await page.locator('span:has-text("Login with Discord")').isVisible()) {
                await page.click('span:has-text("Login with Discord")');
                const confirmBtn = page.locator('button#confirm-login');
                if (await confirmBtn.isVisible({ timeout: 5000 })) await confirmBtn.click();
                await handleOAuthPage(page);
            }

            await page.waitForURL(/dashboard/, { timeout: 20000 });
            
            // 4. 操作服务器
            const serverUrls = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
            });

            allSummary.push(`👤 ${customName}`);
            for (const sUrl of serverUrls) {
                await page.goto(sUrl, { waitUntil: 'networkidle' });
                await page.waitForTimeout(5000);

                const serverName = await page.title().then(t => t.replace('Dashboard - ', ''));
                const wakeUpBtn = page.locator('button:has-text("WAKE UP SERVER")');
                const startBtn = page.locator('button:has-text("Start")').first();
                const restartBtn = page.locator('button:has-text("Restart")').first();

                let action = "跳过";
                if (await wakeUpBtn.isVisible()) {
                    await wakeUpBtn.click();
                    action = "🌙 已唤醒";
                } else if (await startBtn.isVisible() && await startBtn.isEnabled()) {
                    await startBtn.click();
                    action = "🚀 已启动";
                } else if (await restartBtn.isVisible()) {
                    await restartBtn.click();
                    const confirm = page.locator('button:has-text("Confirm")');
                    if (await confirm.isVisible({ timeout: 3000 })) await confirm.click();
                    action = "🔄 已重启";
                }
                allSummary.push(`  ├─ ${serverName}: ${action}`);
            }

        } catch (err) {
            console.error(`❌ ${customName} 失败:`, err.message);
            await page.screenshot({ path: `error-${tIndex}.png` });
            allSummary.push(`  ❌ 账号出错: ${err.message.slice(0, 30)}`);
        } finally {
            await context.close();
        }
    }

    const report = allSummary.join('\n');
    await sendTG(report);
    await browser.close();
});
