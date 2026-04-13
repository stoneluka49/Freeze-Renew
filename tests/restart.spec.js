const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 环境变量配置 ──
const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
    });
}

function sendTG(text) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({
            chat_id: TG_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

test('FreezeHost 自动唤醒 - 核心模块修复版', async () => {
    if (tokens.length === 0) throw new Error('❌ 未配置 DISCORD_TOKEN');

    const browser = await chromium.launch({ headless: true });
    let accountReports = [];
    let totalStats = { servers: 0, actions: 0, failed: 0 };

    try {
        for (let i = 0; i < tokens.length; i++) {
            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);

            let serverResults = [];
            let currentToken = tokens[i];
            
            // 兼容可能带备注的格式
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) { currentToken = match[2].trim(); }

            console.log(`\n🚀 [${i + 1}/${tokens.length}] 正在处理账号...`);

            try {
                // 1. 原始 Discord 注入方式
                await page.goto('https://discord.com/login');
                await page.evaluate((token) => {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }, currentToken);
                
                await page.reload();
                await page.waitForTimeout(5000);

                if (page.url().includes('login')) throw new Error('Discord 登录失败');
                console.log('✅ Discord 登录成功');

                // 2. 登录 FreezeHost
                await page.goto('https://free.freezehost.pro');
                // 修复：使用强制点击进入 Discord 授权
                await page.locator('text=Login with Discord').first().dispatchEvent('click');

                await page.waitForTimeout(5000);
                const confirmBtn = page.locator('#confirm-login');
                if (await confirmBtn.isVisible().catch(() => false)) {
                    await confirmBtn.dispatchEvent('click');
                    await page.waitForTimeout(3000);
                }

                // 3. 服务器唤醒模块 (重点修复)
                await page.waitForSelector('a[href*="server-console"]', { timeout: 15000 }).catch(() => {});
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
                });

                for (const url of serverUrls) {
                    totalStats.servers++;
                    await page.goto(url);
                    await page.waitForTimeout(8000); // 给足面板加载时间

                    const serverName = await page.locator('h1, h2, .server-name').first().innerText().catch(() => 'Unknown');
                    const shortId = url.split('/').pop();

                    let statusEmoji = '🟢';
                    let actionText = '运行中';

                    // 状态判断
                    const bodyText = await page.innerText('body').catch(() => "");
                    const wakeBtn = page.locator('button:has-text("Wake Up Server")').first();
                    const startBtn = page.locator('button:has-text("Start Server")').first();

                    // 核心修复：强制派发点击事件，解决 Element is not visible
                    if (/hibernation|sleep/i.test(bodyText) || await wakeBtn.isVisible().catch(() => false)) {
                        await wakeBtn.dispatchEvent('click');
                        statusEmoji = '⚡';
                        actionText = '已唤醒';
                        totalStats.actions++;
                        await page.waitForTimeout(5000);
                    } else if (await startBtn.isVisible().catch(() => false)) {
                        await startBtn.dispatchEvent('click');
                        statusEmoji = '🚀';
                        actionText = '已启动';
                        totalStats.actions++;
                        await page.waitForTimeout(5000);
                    }

                    console.log(`${statusEmoji} ${serverName} [${actionText}]`);
                    serverResults.push(`${statusEmoji} <b>${serverName}</b> (<code>${shortId}</code>) - <code>${actionText}</code>`);
                }
            } catch (err) {
                totalStats.failed++;
                console.error(`❌ 出错: ${err.message}`);
                serverResults.push(`    ❌ 异常: <code>${err.message.slice(0, 50)}</code>`);
            }

            accountReports.push(`👤 <b>账号 ${i + 1}</b>\n${serverResults.join('\n')}`);
            await context.close();
        }

        // 组装报告
        const finalText = [
            `<b>🎮 FreezeHost 运维报告</b>`,
            `🕒 <code>${nowStr()}</code>`,
            `────────────────────`,
            accountReports.join('\n\n'),
            `────────────────────`,
            `📊 总计: <b>${totalStats.servers}</b> | 操作: <b>${totalStats.actions}</b> | 失败: <b>${totalStats.failed}</b>`,
            `✅ <b>任务执行完毕</b>`
        ].join('\n');

        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
