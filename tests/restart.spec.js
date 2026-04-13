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

// ── Cookie 弹窗清除函数 ──
async function dismissCookiePopup(page) {
    const cookieSelectors = [
        'button.fc-cta-consent',
        'button.fc-button-label',
        '[aria-label="Consent"]',
        'button:has-text("同意")',
        'button:has-text("Accept")',
        'button:has-text("OK")',
    ];
    for (const sel of cookieSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.dispatchEvent('click').catch(() => btn.click({ force: true }));
                console.log(`    ✅ 已关闭 Cookie 遮罩 (${sel})`);
                await page.waitForTimeout(500);
                break;
            }
        } catch { }
    }
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

test('FreezeHost 自动唤醒 - 最终加固版', async () => {
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
            
            // 解析带前缀的 token
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) { currentToken = match[2].trim(); }

            console.log(`\n🚀 [${i + 1}/${tokens.length}] 正在处理账号...`);

            try {
                // 1. Discord 登录
                // 重点：先加载登录页
                await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(2000);

                // 核心注入逻辑：双重写入 + 状态确保
                await page.evaluate((token) => {
                    function setData(t) {
                        localStorage.setItem('token', `"${t}"`);
                        localStorage.setItem('tokens', `["${t}"]`); // 备用字段
                    }
                    setData(token);
                }, currentToken);
                
                // 关键点：注入后先 reload 同域页面，再跳转到 app
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.goto('https://discord.com/app', { waitUntil: 'networkidle' });
                await page.waitForTimeout(5000);

                // 验证跳转结果
                const currentUrl = page.url();
                if (currentUrl.includes('login')) {
                    throw new Error('Token 无效或被 Discord 拦截');
                }
                console.log('✅ Discord 登录成功');

                // 2. 授权登录 FreezeHost
                await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
                await dismissCookiePopup(page);

                const loginBtn = page.locator('text=Login with Discord').first();
                await loginBtn.dispatchEvent('click').catch(() => loginBtn.click({ force: true }));

                await page.waitForTimeout(5000);
                const confirmBtn = page.locator('#confirm-login');
                if (await confirmBtn.isVisible().catch(() => false)) {
                    await confirmBtn.dispatchEvent('click').catch(() => confirmBtn.click({ force: true }));
                    await page.waitForTimeout(4000);
                }

                // 3. 处理服务器
                await page.waitForSelector('a[href*="server-console"]', { timeout: 15000 }).catch(() => {});
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
                });

                for (const url of serverUrls) {
                    totalStats.servers++;
                    await page.goto(url, { waitUntil: 'domcontentloaded' });
                    
                    await page.waitForTimeout(8000); 
                    await dismissCookiePopup(page);

                    const serverName = await page.locator('h1, h2, .server-name').first().innerText().catch(() => 'Unknown');
                    const shortId = url.split('/').pop();

                    let statusEmoji = '🟢';
                    let actionText = '运行中';

                    const bodyText = await page.innerText('body').catch(() => "");
                    const wakeBtn = page.locator('button:has-text("Wake Up Server")').first();
                    const startBtn = page.locator('button:has-text("Start Server")').first();

                    const isHibernating = /hibernation|sleep/i.test(bodyText) || await wakeBtn.isVisible().catch(() => false);
                    const isOffline = await startBtn.isVisible().catch(() => false);

                    if (isHibernating) {
                        await wakeBtn.dispatchEvent('click');
                        statusEmoji = '⚡';
                        actionText = '已唤醒';
                        totalStats.actions++;
                        await page.waitForTimeout(5000);
                    } else if (isOffline) {
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
                console.error(`❌ 处理出错: ${err.message}`);
                serverResults.push(`    ❌ 异常: <code>${err.message.slice(0, 50)}</code>`);
            }

            accountReports.push(`👤 <b>账号 ${i + 1}</b>\n${serverResults.join('\n')}`);
            await context.close();
        }

        const finalText = [
            `<b>🎮 FreezeHost 运维报告</b>`,
            `🕒 <code>${nowStr()}</code>`,
            `────────────────────`,
            accountReports.join('\n\n'),
            `────────────────────`,
            `📊 总计: <b>${totalStats.servers}</b> | 操作: <b>${totalStats.actions}</b> | 失败: <b>${totalStats.failed}</b>`,
            `✅ <b>任务已完成</b>`
        ].join('\n');

        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
