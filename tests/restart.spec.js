const { test, chromium } = require('@playwright/test');
const https = require('https');

const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function sendTG(text) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 FreezeHost 调试报告\n🕒 ${nowStr()}\n${text}` });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, resolve);
        req.on('error', resolve);
        req.write(body); req.end();
    });
}

test('FreezeHost 状态判断调试版', async () => {
    if (tokens.length === 0) throw new Error('❌ 未配置 DISCORD_TOKEN');

    const browser = await chromium.launch({ headless: true });
    let summary = [];

    for (let i = 0; i < tokens.length; i++) {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            locale: 'zh-CN'
        });
        const page = await context.newPage();
        
        let accountLog = `👤 账号 ${i + 1}:\n`;
        console.log(`\n--- 正在处理账号 ${i + 1} ---`);

        try {
            // 1. Discord 登录
            await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
            await page.evaluate(async (token) => {
                const check = () => new Promise(r => {
                    const it = setInterval(() => { if (typeof localStorage !== 'undefined') { clearInterval(it); r(); } }, 100);
                });
                await check();
                localStorage.setItem('token', `"${token}"`);
            }, tokens[i]);

            await page.goto('https://discord.com/channels/@me', { waitUntil: 'networkidle' });
            console.log(`[Log] Discord 页面跳转状态: ${page.url()}`);

            // 2. 进入 Dashboard
            await page.goto('https://free.freezehost.pro/dashboard', { waitUntil: 'networkidle' });
            
            // 自动处理授权逻辑
            if (await page.locator('text=Login with Discord').isVisible()) {
                console.log('[Log] 检测到登录按钮，尝试点击...');
                await page.click('text=Login with Discord');
                await page.waitForTimeout(3000);
                const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权"), #confirm-login');
                if (await authBtn.isVisible()) {
                    console.log('[Log] 点击授权确认按钮');
                    await authBtn.click();
                }
            }

            await page.waitForURL(/dashboard/, { timeout: 20000 });
            console.log('[Log] 已成功进入 Dashboard');

            const serverUrls = await page.evaluate(() => 
                Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href)
            );
            console.log(`[Log] 发现服务器数量: ${serverUrls.length}`);

            for (const url of serverUrls) {
                console.log(`\n[Server Log] 访问控制台: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle' });
                await page.waitForTimeout(5000); // 等待状态刷新

                // --- 状态抓取日志 ---
                const statusText = await page.locator('div, span, p').evaluateAll(els => 
                    els.map(el => el.innerText).find(txt => txt.includes('HIBERNATION') || txt.includes('RUNNING') || txt.includes('OFFLINE'))
                );
                const hasWake = await page.locator('button:has-text("Wake Up Server")').isVisible();
                const hasStart = await page.locator('button:has-text("Start Server")').isVisible();
                const hasStop = await page.locator('button:has-text("Stop Server")').isVisible();

                console.log(`[Status Check] 文字状态: ${statusText || '未抓取到'}`);
                console.log(`[Status Check] 按钮状态: Wake=${hasWake}, Start=${hasStart}, Stop=${hasStop}`);

                let actionResult = '无操作';

                // --- 逻辑判断 ---
                if (hasWake || (statusText && statusText.includes('HIBERNATION'))) {
                    console.log('[Action] 匹配到休眠状态，执行唤醒...');
                    await page.click('button:has-text("Wake Up Server")');
                    actionResult = '⚡ 已唤醒 (Wake)';
                } 
                else if (hasStart) {
                    console.log('[Action] 匹配到离线状态，执行启动...');
                    await page.click('button:has-text("Start Server")');
                    await page.waitForTimeout(5000);
                    // 再次检查是否启动后变休眠
                    if (await page.locator('button:has-text("Wake Up Server")').isVisible()) {
                        console.log('[Action] 启动后检测到休眠，追加唤醒...');
                        await page.click('button:has-text("Wake Up Server")');
                        actionResult = '🚀 启动 + ⚡ 唤醒';
                    } else {
                        actionResult = '🚀 已启动';
                    }
                } 
                else if (hasStop) {
                    console.log('[Action] 服务器正在运行且未休眠，跳过重启');
                    actionResult = '✅ 运行中(跳过)';
                } 
                else {
                    console.log('[Action] 无法识别当前状态，请检查截图');
                    actionResult = '❓ 无法识别';
                }

                const sName = await page.title().then(t => t.replace('Dashboard - ', ''));
                accountLog += `  ├─ ${sName}: ${actionResult}\n`;
            }

        } catch (err) {
            console.error(`[Error] 过程出错: ${err.message}`);
            accountLog += `  ❌ 失败: ${err.message.slice(0, 50)}\n`;
            await page.screenshot({ path: `error-${i}.png`, fullPage: true });
        } finally {
            summary.push(accountLog);
            await context.close();
        }
    }

    await sendTG(summary.join('\n'));
    await browser.close();
});
