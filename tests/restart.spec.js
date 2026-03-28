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

/**
 * 发送美化后的 Telegram 消息 (HTML 模式)
 */
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

test('FreezeHost 自动唤醒 - 稳定加固版', async () => {
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
            console.log(`\n🚀 [${i + 1}/${tokens.length}] 正在处理账号...`);

            try {
                // 1. 稳健的 Discord Token 注入
                await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                await page.evaluate(async (token) => {
                    localStorage.setItem('token', `"${token}"`);
                }, tokens[i]);
                
                // 注入后跳转到 app 页面验证登录
                await page.goto('https://discord.com/app', { waitUntil: 'networkidle' });
                await page.waitForTimeout(3000);

                if (page.url().includes('login')) throw new Error('Token 注入失败或已失效');
                console.log('✅ Discord 登录成功');

                // 2. 授权进入 FreezeHost
                await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
                
                // 监听跳转，防止上下文销毁报错
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
                    page.click('text=Login with Discord', { timeout: 15000 })
                ]);

                const confirmBtn = page.locator('#confirm-login');
                if (await confirmBtn.isVisible().catch(() => false)) {
                    await confirmBtn.click();
                    await page.waitForTimeout(3000);
                }

                // 3. 抓取服务器列表 (增加预检)
                await page.waitForSelector('a[href*="server-console"]', { timeout: 10000 }).catch(() => {});
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
                });

                if (serverUrls.length === 0) {
                    serverResults.push(`    ⚠️ <i>未发现任何服务器实例</i>`);
                }

                for (const url of serverUrls) {
                    totalStats.servers++;
                    await page.goto(url, { waitUntil: 'domcontentloaded' });
                    // 等待控制台核心元素加载，确保页面稳定
                    await page.waitForTimeout(8000); 

                    // 抓取服务器名称
                    const serverName = await page.locator('h1').first().innerText().catch(() => 'Unknown Server');
                    const shortId = url.split('/').pop();

                    let statusEmoji = '🟢';
                    let actionText = '运行中';

                    // 状态判断
                    const bodyText = await page.innerText('body').catch(() => "");
                    const wakeBtn = page.locator('button:has-text("Wake Up Server")');
                    const startBtn = page.locator('button:has-text("Start Server")');

                    const isHibernating = /hibernation|sleep/i.test(bodyText) || await wakeBtn.isVisible().catch(() => false);
                    const isOffline = await startBtn.isVisible().catch(() => false);

                    if (isHibernating) {
                        await wakeBtn.first().click();
                        statusEmoji = '⚡';
                        actionText = '已唤醒';
                        totalStats.actions++;
                        await page.waitForTimeout(5000);
                    } else if (isOffline) {
                        await startBtn.first().click();
                        statusEmoji = '🚀';
                        actionText = '已启动';
                        totalStats.actions++;
                        await page.waitForTimeout(5000);
                    }

                    console.log(`${statusEmoji} ${serverName} [${actionText}]`);
                    serverResults.push(`${statusEmoji} <b>${serverName}</b> (<a href="${url}">${shortId}</a>) - <code>${actionText}</code>`);
                }
            } catch (err) {
                totalStats.failed++;
                console.error(`❌ 处理出错: ${err.message}`);
                serverResults.push(`    ❌ 异常: <code>${err.message}</code>`);
            }

            accountReports.push(`👤 <b>账号 ${i + 1}</b>\n${serverResults.join('\n')}`);
            await context.close();
        }

        // ── 组装发送报告 ──
        const finalText = [
            `<b>🎮 FreezeHost 运维报告</b>`,
            `🕒 <code>${nowStr()}</code>`,
            `────────────────────`,
            accountReports.join('\n\n'),
            `────────────────────`,
            `📊 总计: <b>${totalStats.servers}</b> | 操作: <b>${totalStats.actions}</b> | 失败: <b>${totalStats.failed}</b>`,
            `✅ <b>自动任务已完成</b>`
        ].join('\n');

        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
