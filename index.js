const { connect } = require("puppeteer-real-browser");
const fs = require('fs').promises;
const axios = require('axios');

async function addTurnstileHook(page) {
    await page.evaluateOnNewDocument(() => {
        window.__cfchallenge = { widgetId: null, token: null };
        window.addEventListener('message', (e) => {
            const host = new URL(e.origin).host;
            if (!/challenges\.cloudflare\.com$/i.test(host)) return;
            const data = e.data;

            if (!data || data.source !== 'cloudflare-challenge') { console.log("denying", data); return };
            if (typeof data.widgetId === 'string') window.__cfchallenge.widgetId = data.widgetId;

            let token = null;
            if (data.event === 'complete') token = data.token || null;
            console.log("turnstile", window.turnstile);
            console.log("message", e);
            if (token) __cfchallenge.token = token;
        }, true);
    });
}

async function waitForTurnstileToken(page, timeout = 60000) {
    await page.waitForFunction(() => {
        return !!(window.__cfchallenge && window.__cfchallenge.token);
    }, { timeout });

    return page.evaluate(() => (window.__cfchallenge.token));
}

async function isVisible(page, selector) {
    try {
        return await page.$eval(selector, el => {
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;

            const rect = el.getBoundingClientRect();
            const inViewport =
                rect.width > 0 && rect.height > 0 &&
                rect.bottom >= 0 && rect.right >= 0 &&
                rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.left <= (window.innerWidth || document.documentElement.clientWidth);

            return inViewport;
        });
    } catch {
        return false;
    }
}

async function puppeteerlogin() {
    const { browser, page } = await connect({
        headless: false,
        args: [],
        customConfig: {},
        turnstile: false,
        connectOption: {},
        disableXvfb: false,
        ignoreAllFlags: false,
    });

    const cookieFile = await fs.stat("google-cookies.json").then(() => true).catch(() => false);
    const contents = cookieFile ? await fs.readFile("google-cookies.json", "utf8").then(contents => { console.log(contents); return contents }) : [];
    console.log("Cookie file exists:", ...contents);
    await browser.setCookie(...(cookieFile ? JSON.parse(await fs.readFile("google-cookies.json", "utf8").then(contents => { console.log(contents); return contents })) : []));

    const isOnHost = async (p, host) => {
        try {
            const sum_url = new URL(await p.url());
            console.log("Checking host:", sum_url.host);
            return sum_url.host === host;
        }
        catch { return false; }
    };

    await page.goto("https://accounts.google.com/signin/v2/identifier", { waitUntil: "networkidle2" });
    console.log("loaded");


    let validLogin = await isOnHost(page, "myaccount.google.com");
    console.log("validLogin:", validLogin);
    if (!validLogin) {
        await page.waitForSelector('#identifierId');
        console.log("found selector");

        do {

            const emailLocator = page.locator('input[type="email"]');
            const passwordLocator = page.locator('input[type="password"]');

            //const emailVisible = await page.locator('input[type="email"]').map(input => input.isVisible).wait();
            //console.log("Email visible:", emailVisible, emailLocator);

            if (await isVisible(page, 'input[type="email"]')) {
                // console.log("Entering email");
                await page.type('input[type="email"]', '@gmail.com'); // Replace 'your_email@gmail.com' with your actual email
                //await page.click('#identifierNext');
            }

            if (await passwordLocator.map(input => input.isVisible).wait()) {
                // console.log("Entering password");
                // await page.type('input[type="password"]', '');
                // await page.click('#passwordNext');
            }


            await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 180_000 });
            validLogin = await isOnHost(page, "myaccount.google.com");
        } while (!validLogin);
    };
    console.log("done!");


    async function getEmailFromAriaLabel(page) {
        const label = await page.evaluate(() => {
            const el =
                document.querySelector('a[aria-label^="Google Account:"]') ||
                document.querySelector('button[aria-label^="Google Account:"]');
            return el?.getAttribute('aria-label') || null;
        });
        if (!label) return null;
        const m = label.match(/\(([^)]+@[^)]+)\)/);
        return m ? m[1] : null;
    }
    const email = await getEmailFromAriaLabel(page);
    console.log('Email:', email);

    const browserCookies = await browser.cookies()
    const keep = browserCookies.filter(c =>
        c.domain.includes('google')
    );

    //fs.writeFile(`${email.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/, '_')}-cookies.json`, JSON.stringify(browserCookies, null, 2));
    await fs.writeFile(`google-cookies.json`, JSON.stringify(browserCookies, null, 2));

    addTurnstileHook(page)
    await page.goto("https://wplace.live", { waitUntil: "networkidle2" });

    //fetch user data
    const response = await page.evaluate(async () => {
        return await fetch('https://backend.wplace.live/me', {
            credentials: 'include',
            headers: {
                'Accept': 'application/json'
            }
        }).then(res => res.json()).catch(err => console.log("Fetch error:", err));
    });

    //user is not logged in
    if (!response.id) {
        console.log("Fetch response:", response);
        page.turnstile = true
        const loginButton = await page.waitForSelector('button ::-p-text(Log in)', { visible: true, timeout: 1_000 }).then(() => true).catch(() => false);
        if (loginButton) {
            await page.click('button ::-p-text(Log in)');
        }

        const foundCaptcha = await page.waitForSelector('input[type="hidden"][name="cf-turnstile-response"]', { timeout: 10_000 }).then(() => true).catch(() => false);
        if (foundCaptcha) {
            console.log("Waiting cloudflare turnstile to complete");
            const token = await page.waitForFunction(() => {
                const el = document.querySelector('input[name="cf-turnstile-response"]');
                return el && el.value && el.value.length > 10 ? el.value : null;
            }, { timeout: 60000 }).then(h => h.jsonValue());
        } else {
            console.log("No captcha found");
        }

        const googleLoginButton = await page.waitForSelector('::-p-text(Login with Google)', { visible: true, timeout: 1_000 }).then(() => true).catch(() => false);
        console.log("Google login button found:", googleLoginButton);
        if (googleLoginButton) {
            await page.click('::-p-text(Login with Google)');
        }
    }
    page.turnstile = true

    let tkn = await waitForTurnstileToken(page);
    console.log(tkn);

    if (await isVisible(page, 'button ::-p-text(X)')) {
        console.log("Exiting rules");
        await page.click("button ::-p-text(X)");
    }

    const newCookies = browserCookies.filter(c =>
        c.domain.includes('google') ||
        c.domain.includes('wplace.live') ||
        c.domain.includes('backend.wplace.live') ||
        c.domain.includes('cloudflare')
    );
    await fs.writeFile(`google-cookies.json`, JSON.stringify(newCookies, null, 2));
}
puppeteerlogin();