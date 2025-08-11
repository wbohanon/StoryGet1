const EnhancedStoryScraper = require('./enhanced-scraper-v2');

async function testScraper() {
    const scraper = new EnhancedStoryScraper();
    
    try {
        await scraper.init();
        console.log('✅ Scraper initialized successfully');
        
        // Example URLs to test (replace with actual URLs you want to scrape)
        const testUrls = [
            // Add your test URLs here
            // 'https://example-story-site.com/story1',
            // 'https://another-site.com/chapter1'
        ];
        
        if (testUrls.length === 0) {
            console.log('ℹ️  No test URLs provided. Add URLs to the testUrls array to test.');
            console.log('ℹ️  You can also use the debug method to troubleshoot specific URLs:');
            console.log('');
            console.log('Example usage:');
            console.log('  const scraper = new EnhancedStoryScraper();');
            console.log('  await scraper.init();');
            console.log('  await scraper.debugScrape("https://your-story-url.com");');
            console.log('  await scraper.close();');
            console.log('');
            return;
        }
        
        for (const url of testUrls) {
            console.log('\n' + '='.repeat(80));
            console.log(`Testing URL: ${url}`);
            console.log('='.repeat(80));
            
            try {
                // Use debugScrape to see detailed extraction information
                const result = await scraper.debugScrape(url);
                
                if (result.content.length < 100) {
                    console.log('⚠️  WARNING: Content seems too short, might indicate extraction issues');
                }
                
            } catch (error) {
                console.log(`❌ Error scraping ${url}:`, error.message);
            }
            
            // Add delay between requests to be respectful
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await scraper.close();
        console.log('✅ Scraper closed');
    }
}

// If run directly, execute test
if (require.main === module) {
    testScraper().catch(console.error);
}

module.exports = { testScraper };