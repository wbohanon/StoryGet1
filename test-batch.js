const EnhancedStoryScraper = require('./enhanced-scraper-v3');

async function testBatchScraping() {
    const scraper = new EnhancedStoryScraper();
    await scraper.init();

    console.log('🧪 Testing Batch Link Discovery\n');

    try {
        // Test with a simple webpage that has links
        const testUrl = 'https://example.com';
        console.log('Testing with:', testUrl);

        const result = await scraper.scrapeLinksFromPage(testUrl, {
            linkSelector: 'a[href]',
            maxLinks: 5,
            sameDomain: false,
            keywords: []
        });

        console.log('✅ Result:', result);
        console.log('📊 Total found:', result.totalFound);
        console.log('🔗 Unique links:', result.uniqueLinks);
        console.log('📋 Links to scrape:', result.linksToScrape.length);

        if (result.linksToScrape.length > 0) {
            console.log('\n📋 Sample links:');
            result.linksToScrape.slice(0, 3).forEach((link, i) => {
                console.log(`  ${i + 1}. ${link.text || 'No text'}`);
                console.log(`     ${link.url}`);
                console.log(`     Domain: ${link.domain}`);
            });
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        await scraper.close();
    }
}

testBatchScraping();