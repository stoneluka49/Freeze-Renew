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

test('FreezeHost 自动唤醒 + 自动启动（精简版）', async () => {

    if (tokens.length === 0) {
        throw new Error('❌ 未配置 DISCORD_TOKEN');
    }

    const browser = await chromium.launch({ headless: true });

    let summary = [];

    try {
        for (let i = 0; i < tokens.length; i++) {

            console.log(`🚀 开始处理账号 ${i + 1}`);

            const context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);

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

                console.log('✅ Discord 登录成功');

                // ── 登录 FreezeHost ──
                await page.goto('https://free.freezehost.pro');

                await page.click('text=Login with Discord');

                const confirm = page.locator('#confirm-login');
                if (await confirm.isVisible().catch(() => false)) {
                    await confirm.click();
                }

                await page.waitForTimeout(5000);

                // ── 获取服务器列表 ──
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]'))
                        .map(a => a.href);
                });

                console.log(`🔧 找到 ${serverUrls.length} 个服务器`);

                for (const url of serverUrls) {

                    await page.goto(url);
                    await page.waitForTimeout(3000);

                    console.log(`🔧 处理服务器: ${url}`);

                    let actionResult = '';

                    try {
                        // ── 精简逻辑：只判断休眠和停止状态 ──
                        const isHibernating = await page.locator('text=HIBERNATION').isVisible().catch(() => false);
                        const hasStartBtn = await page.locator('button:has-text("Start Server")').isVisible().catch(() => false);

                        if (isHibernating) {
                            console.log('💤 Hibernation → 唤醒');
                            await page.locator('button:has-text("Wake Up Server")').first().click();
                            await page.waitForTimeout(8000);
                            actionResult = '⚡ 已唤醒';
                        } 
                        else if (hasStartBtn) {
                            console.log('🔴 OFFLINE → 启动');
                            await page.locator('button:has-text("Start Server")').click();
                            await page.waitForTimeout(8000);

                            const stillHibernating = await page.locator('text=HIBERNATION').isVisible().catch(() => false);
                            if (stillHibernating) {
                                console.log('💤 启动后仍休眠 → 再唤醒');
                                await page.locator('button:has-text("Wake Up Server")').first().click();
                                await page.waitForTimeout(8000);
                                actionResult = '🚀 启动 + ⚡ 唤醒';
                            } else {
                                actionResult = '🚀 已启动';
                            }
                        } 
                        else {
                            actionResult = '🟢 运行中，无需操作';
                        }

                    } catch (err) {
                        actionResult = '❌ 操作失败';
                        console.log(err.message);
                    }

                    result += `\n${url}\n${actionResult}\n`;
                }

            } catch (err) {
                result = `❌ 登录失败: ${err.message}`;
            }

            summary.push(`👤 账号${i + 1}\n${result}`);

            await context.close();
        }

        const finalText = [
            '🎮 FreezeHost 自动运行报告',
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
