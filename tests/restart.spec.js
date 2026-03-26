const { test, chromium } = require('@playwright/test');
const https = require('https');

const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
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

test('FreezeHost 自动唤醒 / 自动重启', async () => {

    if (tokens.length === 0) {
        throw new Error('未配置 DISCORD_TOKEN');
    }

    const browser = await chromium.launch({
        headless: true
    });

    let summary = [];

    try {

        for (let i = 0; i < tokens.length; i++) {

            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);

            let result = '';

            try {

                console.log('登录 Discord...');

                await page.goto('https://discord.com/login');

                await page.evaluate(token => {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }, tokens[i]);

                await page.reload();
                await page.waitForTimeout(4000);

                if (page.url().includes('login')) {
                    throw new Error('Token 失效');
                }

                console.log('登录 FreezeHost...');

                await page.goto('https://free.freezehost.pro');
                await page.click('text=Login with Discord');

                const confirm = page.locator('#confirm-login');
                if (await confirm.isVisible().catch(() => false)) {
                    await confirm.click();
                }

                await page.waitForTimeout(5000);

                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]'))
                        .map(a => a.href);
                });

                if (serverUrls.length === 0) {
                    result = '未找到服务器';
                }

                for (const url of serverUrls) {

                    console.log('处理服务器:', url);

                    await page.goto(url);
                    await page.waitForTimeout(4000);

                    let actionResult = '';

                    try {

                        const isHibernating = await page.locator('text=HIBERNATION')
                            .isVisible()
                            .catch(() => false);

                        const hasStart = await page.locator('button:has-text("Start Server")')
                            .isVisible()
                            .catch(() => false);

                        const hasStop = await page.locator('button:has-text("Stop Server")')
                            .isVisible()
                            .catch(() => false);

                        if (isHibernating) {

                            console.log('服务器休眠 → 唤醒');

                            const wakeBtn = page.locator('button:has-text("Wake Up Server")').first();
                            await wakeBtn.click();

                            await page.waitForTimeout(8000);
                            actionResult = '已唤醒';
                        }

                        else if (hasStart) {

                            console.log('服务器 OFFLINE → 启动');

                            const startBtn = page.locator('button:has-text("Start Server")').first();
                            await startBtn.click();

                            await page.waitForTimeout(8000);
                            actionResult = '已启动';
                        }

                        else if (hasStop) {

                            console.log('服务器 RUNNING → 重启');

                            const stopBtn = page.locator('button:has-text("Stop Server")').first();
                            await stopBtn.click();

                            await page.waitForTimeout(8000);

                            const startBtn = page.locator('button:has-text("Start Server")').first();
                            await startBtn.waitFor({ state: 'visible', timeout: 15000 });
                            await startBtn.click();

                            await page.waitForTimeout(8000);

                            actionResult = '已重启';
                        }

                        else {
                            actionResult = '状态未知';
                        }

                    } catch (err) {
                        console.log(err.message);
                        actionResult = '操作失败';
                    }

                    result += `\n${url}\n${actionResult}\n`;
                }

            } catch (err) {
                result = `失败: ${err.message}`;
            }

            summary.push(`账号${i + 1}\n${result}`);

            await context.close();
        }

        const report = [
            'FreezeHost 运行报告',
            nowStr(),
            '================',
            summary.join('\n')
        ].join('\n');

        console.log(report);

        await sendTG(report);

    } finally {
        await browser.close();
    }
});
