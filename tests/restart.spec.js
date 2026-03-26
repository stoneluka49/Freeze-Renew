const { test, chromium } = require('@playwright/test');
const https = require('https');

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
            text
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

test('FreezeHost 自动重启/唤醒', async () => {

    if (tokens.length === 0) {
        throw new Error('❌ 未配置 DISCORD_TOKEN');
    }

    const browser = await chromium.launch({ headless: true });

    let summary = [];

    try {
        for (let i = 0; i < tokens.length; i++) {

            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);

            let label = `账号${i + 1}`;
            let result = '';

            try {
                // ── Discord Token 登录 ──
                await page.goto('https://discord.com/login');

                await page.evaluate(token => {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }, tokens[i]);

                await page.reload();
                await page.waitForTimeout(3000);

                if (page.url().includes('login')) {
                    throw new Error('Token 失效');
                }

                // ── 登录 FreezeHost ──
                await page.goto('https://free.freezehost.pro');

                await page.click('text=Login with Discord');

                const confirm = page.locator('#confirm-login');
                if (await confirm.isVisible().catch(() => false)) {
                    await confirm.click();
                }

                // OAuth 自动通过
                await page.waitForTimeout(5000);

                // ── 获取服务器列表 ──
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]'))
                        .map(a => a.href);
                });

                for (const url of serverUrls) {

                    await page.goto(url);
                    await page.waitForTimeout(3000);

                    console.log(`🔧 处理服务器: ${url}`);

                    let actionResult = '';

                    try {
                        const isHibernating = await page.locator('text=HIBERNATION')
                            .isVisible()
                            .catch(() => false);

                        if (isHibernating) {
                            // 💤 唤醒
                            const wakeBtn = page.locator('button:has-text("Wake Up Server")').first();

                            await wakeBtn.waitFor({ state: 'visible', timeout: 10000 });
                            await wakeBtn.click();

                            console.log('⚡ 已唤醒');
                            await page.waitForTimeout(8000);

                            actionResult = '⚡ 唤醒成功';

                        } else {
                            // 🔁 重启
                            const stopBtn = page.locator('button:has-text("Stop Server")');

                            await stopBtn.waitFor({ state: 'visible', timeout: 10000 });
                            await stopBtn.click();

                            console.log('⛔ 已停止');
                            await page.waitForTimeout(8000);

                            const startBtn = page.locator('button:has-text("Start Server")');

                            await startBtn.waitFor({ state: 'visible', timeout: 15000 });
                            await startBtn.click();

                            console.log('🚀 已启动');
                            await page.waitForTimeout(8000);

                            actionResult = '🔁 重启成功';
                        }

                    } catch (e) {
                        actionResult = '❌ 操作失败';
                        console.log(e.message);
                    }

                    result += `\n${url}\n${actionResult}\n`;
                }

            } catch (err) {
                result = `❌ 失败: ${err.message}`;
            }

            summary.push(`👤 ${label}\n${result}`);
            await context.close();
        }

        const finalText = [
            '🎮 FreezeHost 重启报告',
            `🕒 ${nowStr()}`,
            '================',
            summary.join('\n')
        ].join('\n');

        console.log(finalText);
        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
