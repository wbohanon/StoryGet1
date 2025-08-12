const EnhancedStoryScraper = require('./enhanced-scraper-v3');

async function testStorySaving() {
    const scraper = new EnhancedStoryScraper();
    await scraper.init();

    console.log('🧪 Testing Story Saving and Retrieval\n');

    try {
        // Test 1: Scrape a simple page
        console.log('1. Testing story scraping...');
        const testUrl = 'https://example.com';
        const result = await scraper.scrape(testUrl);
        
        console.log('✅ Scrape result:', {
            skipped: result.skipped,
            storyId: result.story?.id,
            title: result.story?.title
        });

        // Test 2: Get all stories
        console.log('\n2. Testing story retrieval...');
        const allStories = await scraper.getAllStories();
        console.log('✅ Total stories in database:', allStories.length);

        if (allStories.length > 0) {
            console.log('\n📚 Sample stories:');
            allStories.slice(0, 3).forEach((story, i) => {
                console.log(`  ${i + 1}. ${story.title}`);
                console.log(`     URL: ${story.url}`);
                console.log(`     Words: ${story.word_count}`);
                console.log(`     Domain: ${story.domain}`);
                console.log(`     Scraped: ${story.scraped_at}`);
            });
        }

        // Test 3: Try scraping the same URL again (should be skipped)
        console.log('\n3. Testing duplicate detection...');
        const duplicateResult = await scraper.scrape(testUrl);
        console.log('✅ Duplicate scrape result:', {
            skipped: duplicateResult.skipped,
            reason: duplicateResult.reason
        });

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await scraper.close();
    }
}

testStorySaving();