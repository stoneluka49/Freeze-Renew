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

test('FreezeHost 自动唤醒 + 详细日志诊断版', async () => {

    if (tokens.length === 0) {
        throw new Error('❌ 未配置 DISCORD_TOKEN');
    }

    const browser = await chromium.launch({ headless: true });
    let summary = [];

    try {
        for (let i = 0; i < tokens.length; i++) {
            console.log(`\n================================`);
            console.log(`🚀 开始处理账号 ${i + 1} / ${tokens.length}`);
            console.log(`================================`);

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
                await page.waitForTimeout(5000);

                if (page.url().includes('login')) {
                    throw new Error('Token 可能已失效或需要人机验证');
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
                    console.log(`\n🔍 正在进入面板: ${url}`);
                    await page.goto(url);
                    
                    // 等待面板状态加载（FreezeHost 状态有时是动态加载的）
                    await page.waitForTimeout(6000);

                    let actionResult = '';

                    try {
                        // --- 核心诊断逻辑 ---
                        // 1. 获取页面纯文本用于正则匹配
                        const bodyText = await page.innerText('body').catch(() => "");
                        const hasHiberKeyword = /hibernation|sleep/i.test(bodyText);
                        
                        // 2. 检测关键元素
                        const hiberTextVisible = await page.locator('text=/hibernation|sleep/i').isVisible().catch(() => false);
                        const wakeBtn = page.locator('button:has-text("Wake Up Server")');
                        const wakeBtnVisible = await wakeBtn.isVisible().catch(() => false);
                        const startBtn = page.locator('button:has-text("Start Server")');
                        const startBtnVisible = await startBtn.isVisible().catch(() => false);

                        console.log(`📊 [状态检查]`);
                        console.log(`   - 文本包含关键字 (Regex): ${hasHiberKeyword}`);
                        console.log(`   - 关键字元素可见 (Selector): ${hiberTextVisible}`);
                        console.log(`   - "Wake Up Server" 按钮可见: ${wakeBtnVisible}`);
                        console.log(`   - "Start Server" 按钮可见: ${startBtnVisible}`);

                        // --- 决策树 ---
                        if (wakeBtnVisible || hiberTextVisible || hasHiberKeyword) {
                            console.log('💤 识别到休眠状态 -> 执行唤醒');
                            await wakeBtn.first().click();
                            await page.waitForTimeout(10000); // 唤醒需要较长时间
                            actionResult = '⚡ 已执行唤醒 (Wake Up)';
                        } 
                        else if (startBtnVisible) {
                            console.log('🔴 识别到停止状态 -> 执行启动');
                            await startBtn.click();
                            await page.waitForTimeout(8000);

                            // 启动后可能会瞬间变回休眠，二次检查
                            const secondCheckHiber = await page.locator('text=/hibernation|sleep/i').isVisible().catch(() => false);
                            if (secondCheckHiber) {
                                console.log('💤 启动后检测到休眠 -> 追回一次唤醒');
                                await page.locator('button:has-text("Wake Up Server")').first().click();
                                await page.waitForTimeout(5000);
                                actionResult = '🚀 已启动 + ⚡ 追回唤醒';
                            } else {
                                actionResult = '🚀 已启动 (Start)';
                            }
                        } 
                        else {
                            // 如果以上都没有，可能已经在运行，或者页面加载失败
                            const currentStatusText = await page.locator('.status-text, #status').innerText().catch(() => "未知");
                            console.log(`🟢 未触发操作。当前可能状态: ${currentStatusText}`);
                            actionResult = '🟢 运行中或状态无需操作';
                        }

                    } catch (err) {
                        actionResult = `❌ 操作异常: ${err.message}`;
                        console.log(err);
                    }

                    result += `\n🔗 ${url.split('/').pop()}\n📝 ${actionResult}\n`;
                }

            } catch (err) {
                console.error(`❌ 账号处理失败: ${err.message}`);
                result = `❌ 登录/处理失败: ${err.message}`;
            }

            summary.push(`👤 账号${i + 1}\n${result}`);
            await context.close();
        }

        const finalText = [
            '🎮 FreezeHost 运行报告',
            `🕒 ${nowStr()}`,
            '================',
            summary.join('\n')
        ].join('\n');

        console.log('\n' + finalText);
        await sendTG(finalText);

    } finally {
        await browser.close();
    }
});
