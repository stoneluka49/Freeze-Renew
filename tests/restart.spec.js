const { test, chromium } = require('@playwright/test');
const https = require('https');

// 环境配置
const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// Telegram 通知函数
async function sendTG(text) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 FreezeHost 运行报告\n🕒 ${nowStr()}\n${text}` });
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
        console.log(`\n>>>>>> 🚀 正在处理账号 ${i + 1} <<<<<<`);
        
        // 模拟真实浏览器环境
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            locale: 'zh-CN'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);

        let accountResult = `👤 账号 ${i + 1}:\n`;

        try {
            // 1. Discord Token 注入登录
            console.log('[Step 1] 注入 Discord Token...');
            await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
            
            await page.evaluate(async (token) => {
                const waitForStorage = () => new Promise(res => {
                    const check = () => { if (typeof localStorage !== 'undefined') res(); else setTimeout(check, 100); };
                    check();
                });
                await waitForStorage();
                localStorage.setItem('token', `"${token}"`);
                // 辅助注入
                const iframe = document.createElement('iframe');
                document.body.appendChild(iframe);
                if (iframe.contentWindow) iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
            }, tokens[i]);

            await page.goto('https://discord.com/channels/@me', { waitUntil: 'networkidle' });
            console.log(`[Log] 当前 URL: ${page.url()}`);
            if (page.url().includes('login')) throw new Error('Token 失效或触发验证码');

            // 2. 登录 FreezeHost
            console.log('[Step 2] 访问 FreezeHost...');
            await page.goto('https://free.freezehost.pro/dashboard', { waitUntil: 'networkidle' });

            if (await page.locator('text=Login with Discord').isVisible()) {
                console.log('[Log] 发现登录按钮，尝试授权...');
                await page.click('text=Login with Discord');
                await page.waitForTimeout(3000);
                const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权"), #confirm-login');
                if (await authBtn.isVisible()) await authBtn.click();
            }

            await page.waitForURL(/dashboard/, { timeout: 20000 });
            console.log('[Log] 成功进入 Dashboard');

            // 3. 遍历服务器列表
            const serverUrls = await page.evaluate(() => 
                Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href)
            );
            console.log(`[Log] 找到 ${serverUrls.length} 个服务器控制台链接`);

            for (const url of serverUrls) {
                console.log(`\n[Server Check] 地址: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle' });
                await page.waitForTimeout(5000); // 等待面板数据加载

                // --- 深度调试：状态抓取 ---
                // 抓取页面上可能包含状态文字的元素内容
                const pageContent = await page.evaluate(() => document.body.innerText);
                const isHibernating = /hibernation|sleep|休眠/i.test(pageContent);
                
                // 检查按钮可见性
                const wakeBtn = page.locator('button:has-text("Wake Up Server")').first();
                const startBtn = page.locator('button:has-text("Start Server")').first();
                const stopBtn = page.locator('button:has-text("Stop Server")').first();

                const hasWake = await wakeBtn.isVisible();
                const hasStart = await startBtn.isVisible();
                const hasStop = await stopBtn.isVisible();

                console.log(`[Debug Info] 休眠关键字检测: ${isHibernating}`);
                console.log(`[Debug Info] 按钮检测: Wake=${hasWake}, Start=${hasStart}, Stop=${hasStop}`);

                let actionTaken = '🟢 运行中(无操作)';

                // --- 判断逻辑 ---
                if (hasWake || isHibernating) {
                    console.log('[Action] 检测到休眠/唤醒需求');
                    await wakeBtn.click();
                    await page.waitForTimeout(8000);
                    actionTaken = '⚡ 已唤醒 (Wake)';
                } 
                else if (hasStart) {
                    console.log('[Action] 检测到离线状态，正在启动...');
                    await startBtn.click();
                    await page.waitForTimeout(8000);
                    
                    // 再次检查启动后是否立即进入休眠
                    const postStartContent = await page.evaluate(() => document.body.innerText);
                    if (/hibernation|sleep|休眠/i.test(postStartContent) || await wakeBtn.isVisible()) {
                        console.log('[Action] 启动后仍休眠，执行二次唤醒');
                        await wakeBtn.click();
                        actionTaken = '🚀 启动 + ⚡ 唤醒';
                    } else {
                        actionTaken = '🚀 已启动';
                    }
                } 
                else if (hasStop) {
                    console.log('[Action] 服务器正常运行且未休眠');
                    actionTaken = '✅ 运行中';
                }
                else {
                    console.log('[Action] 警告：无法识别任何状态按钮');
                    actionTaken = '❓ 无法识别状态';
                }

                const sName = await page.title().then(t => t.replace('Dashboard - ', ''));
                accountResult += `  ├─ ${sName}: ${actionTaken}\n`;
            }

        } catch (err) {
            console.error(`[Error] 处理失败: ${err.message}`);
            accountResult += `  ❌ 出错: ${err.message.slice(0, 40)}\n`;
            await page.screenshot({ path: `error-account-${i}.png`, fullPage: true });
        } finally {
            summary.push(accountResult);
            await context.close();
        }
    }

    const report = summary.join('\n');
    console.log('\n==== 最终汇总报告 ====\n', report);
    await sendTG(report);
    await browser.close();
});
