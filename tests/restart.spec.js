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

test('FreezeHost 自动唤醒 - 严格状态分支版', async () => {
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
            
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) { currentToken = match[2].trim(); }

            console.log(`\n🚀 [${i + 1}/${tokens.length}] 正在处理账号...`);

            try {
                // 1. Discord 登录
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
                await page.locator('text=Login with Discord').first().dispatchEvent('click');

                await page.waitForTimeout(5000);
                const confirmBtn = page.locator('#confirm-login');
                if (await confirmBtn.isVisible().catch(() => false)) {
                    await confirmBtn.dispatchEvent('click');
                    await page.waitForTimeout(3000);
                }

                // 3. 服务器控制逻辑
                await page.waitForSelector('a[href*="server-console"]', { timeout: 15000 }).catch(() => {});
                const serverUrls = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(a => a.href);
                });

                for (const url of serverUrls) {
                    totalStats.servers++;
                    await page.goto(url);
                    
                    // 等待 WebSocket 握手和面板状态渲染
                    await page.waitForSelector('span:has-text("Connected"), .server-name, h1', { timeout: 15000 }).catch(() => {});
                    await page.waitForTimeout(6000); 

                    // 精准抓取服务器名字
                    const serverName = await page.locator('h1').first().innerText()
                        .catch(() => page.locator('.server-name').first().innerText())
                        .catch(() => 'Unknown Server');
                        
                    const shortId = url.split('/').pop();

                    let statusEmoji = '🟢';
                    let actionText = '运行中';

                    // 公用按钮/状态文本定位器定义
                    const wakeBtn = page.locator('button:has-text("WAKE UP"), button:has-text("Wake Up")').first();
                    const startBtn = page.locator('button:has-text("START"), button:has-text("Start")').first();
                    const restartBtn = page.locator('button:has-text("RESTART"), button:has-text("Restart")').first();
                    
                    // 抓取大状态卡片区文本 (精确区分 RUNNING 或 OFFLINE)
                    const statusCardText = await page.locator('div:has-text("RUNNING"), div:has-text("OFFLINE")').first().innerText().catch(() => "");
                    const isRunning = /RUNNING/i.test(statusCardText);
                    const isOffline = /OFFLINE/i.test(statusCardText);

                    console.log(`[${serverName.trim()}] 面板检测大状态: ${isRunning ? 'RUNNING' : isOffline ? 'OFFLINE' : 'UNKNOWN'}`);

                    // ── 分支 1：如果是 RUNNING ──
                    if (isRunning) {
                        // 检查是否有 wake up 按钮
                        if (await wakeBtn.isVisible().catch(() => false)) {
                            console.log(`  └─ 🟡 发现 Wake Up 按钮，执行唤醒。`);
                            await wakeBtn.dispatchEvent('click');
                            statusEmoji = '⚡';
                            actionText = '已唤醒';
                            totalStats.actions++;
                            await page.waitForTimeout(5000);
                        } else {
                            // 没有 wake up 按钮，则执行 restart server
                            console.log(`  └─ 🔄 未发现 Wake Up 按钮，直接执行 Restart 重启。`);
                            if (await restartBtn.isVisible().catch(() => false)) {
                                await restartBtn.dispatchEvent('click');
                            } else {
                                // 如果没找到特定重启键，尝试强制派发给可能存在的同名动作键
                                await page.locator('button:has-text("RESTART")').first().dispatchEvent('click').catch(() => {});
                            }
                            statusEmoji = '🔄';
                            actionText = '已重启服务器';
                            totalStats.actions++;
                            await page.waitForTimeout(5000);
                        }
                    } 
                    // ── 分支 2：如果是 OFFLINE ──
                    else if (isOffline || await startBtn.isVisible().catch(() => false)) {
                        console.log(`  └─ 🔴 状态为 OFFLINE，正在点击 START 启动...`);
                        await startBtn.dispatchEvent('click');
                        statusEmoji = '🚀';
                        actionText = '已启动';
                        totalStats.actions++;
                        
                        // 启动后强制等待 8 秒让面板同步状态流
                        await page.waitForTimeout(8000); 

                        // 【二次检查】启动后看需不需要 wake up
                        const bodyTextAfterStart = await page.innerText('body').catch(() => "");
                        const isHibernatingText = /HIBERNATION|⚡/i.test(bodyTextAfterStart);

                        if (await wakeBtn.isVisible().catch(() => false) || isHibernatingText) {
                            console.log(`     └─ ⚡ 二次检查触发：启动后检测到休眠，紧接着执行 Wake Up 唤醒！`);
                            await wakeBtn.dispatchEvent('click');
                            statusEmoji = '⚡';
                            actionText = '已启动并唤醒';
                            await page.waitForTimeout(5000);
                        }
                    } else {
                        // 未识别到明确大状态的兜底安全处理
                        console.log(`  └─ ⚠️ 未检测到明确的大状态文本，执行常规安全唤醒检测...`);
                        if (await wakeBtn.isVisible().catch(() => false)) {
                            await wakeBtn.dispatchEvent('click');
                            statusEmoji = '⚡';
                            actionText = '常规唤醒';
                            totalStats.actions++;
                        }
                    }

                    console.log(`[Result] ${statusEmoji} ${serverName.trim()} -> ${actionText}`);
                    serverResults.push(`${statusEmoji} <b>${serverName.trim()}</b> (<code>${shortId}</code>) - <code>${actionText}</code>`);
                }
            } catch (err) {
                totalStats.failed++;
                console.error(`❌ 出错: ${err.message}`);
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
            `✅ <b>任务执行完毕</b>`
        ].join('\n');

        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
