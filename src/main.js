import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'inmobiliaria', 
        location = 'Madrid', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'ES'
    });

    log.info(`Searching PaginasAmarillas (Spain) for "${keyword}" in "${location}"`);
    
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            // Accept cookies if presented
            await page.locator('#onetrust-accept-btn-handler, button:has-text("Aceptar"), .didomi-continue-without-agreeing').click({ timeout: 5000 }).catch(() => {});
            
            await page.waitForSelector('.listado-item, .box, .comercio, .result-item, .item-list, [data-id]', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied') || title.includes('Attention Required')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Scroll down to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.listado-item, .comercio, .box, .result-item, [itemtype="http://schema.org/LocalBusiness"]');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, .commerce-name, [itemprop="name"], .name');
                if (!nameElement) continue;
                const businessName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.commerce-address, [itemprop="address"], .address');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Category
                const catElement = await item.$('.category, .commerce-category, [itemprop="category"]');
                const industry = catElement ? (await catElement.innerText()).trim() : keyword;

                // Phones
                // Note: might be obscured by a "ver telefono" button that triggers a modal or reveals text
                const phoneElement = await item.$('a[href^="tel:"], .commerce-phone, [itemprop="telephone"]');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }
                
                // Website
                const websiteElement = await item.$('.web, a[itemprop="url"], a.web-link, a.commerce-web');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                // URL
                const urlElement = await item.$('h2 a, .commerce-name a');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.paginasamarillas.es').toString() : listingUrl;

                if (businessName && businessName.length > 1) {
                    const record = {
                        businessName,
                        industry,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl || request.url,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${businessName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('.pagination .next, a[rel="next"], a.next');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.paginasamarillas.es').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const formatKeyword = encodeURIComponent(keyword.toLowerCase());
    const formatLocation = encodeURIComponent(location.toLowerCase());
    // Generic PaginasAmarillas Search URL structure
    const startUrl = `https://www.paginasamarillas.es/search/${formatKeyword}/all-ma/${formatLocation}/all-is/${formatLocation}/all-ba/all-pu/all-nc/1`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} Spanish Business leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
