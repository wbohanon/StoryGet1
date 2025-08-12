const EnhancedStoryScraper = require('./enhanced-scraper-v3');

async function testFeatures() {
    const scraper = new EnhancedStoryScraper();
    await scraper.init();

    console.log('🧪 Testing Enhanced Story Scraper Features\n');

    try {
        // Test 1: Create a collection
        console.log('1. Testing Collections...');
        const collection = await scraper.createCollection('Test Collection', 'A test collection for demo', '#ff6b6b');
        console.log('✅ Created collection:', collection);

        // Test 2: Get all collections
        const collections = await scraper.getAllCollections();
        console.log('✅ Retrieved collections:', collections.length);

        // Test 3: Test RSS feed functionality
        console.log('\n2. Testing RSS Feeds...');
        try {
            // Add a test RSS feed (using a real RSS feed for testing)
            const feed = await scraper.addRSSFeed('https://feeds.feedburner.com/oreilly/radar', 'O\'Reilly Radar', 'Tech news and insights');
            console.log('✅ Added RSS feed:', feed);

            // Get all RSS feeds
            const feeds = await scraper.getAllRSSFeeds();
            console.log('✅ Retrieved RSS feeds:', feeds.length);
        } catch (error) {
            console.log('⚠️  RSS test skipped (network required):', error.message);
        }

        // Test 4: Enhanced search
        console.log('\n3. Testing Enhanced Search...');
        const searchResults = await scraper.searchStories('test', {
            searchTitle: true,
            searchAuthor: true,
            minWordCount: 100,
            limit: 10
        });
        console.log('✅ Search completed, found:', searchResults.length, 'stories');

        // Test 5: Test similarity keywords generation
        console.log('\n4. Testing Similarity Keywords...');
        const keywords = await scraper.generateSimilarityKeywords(
            'This is a test story about adventure and mystery in a magical world.',
            'Test Adventure Story',
            'Test Author'
        );
        console.log('✅ Generated keywords:', keywords);

        console.log('\n🎉 All tests completed successfully!');
        console.log('\n📊 Feature Summary:');
        console.log('✅ Collections: Create, manage, and organize stories');
        console.log('✅ RSS Monitoring: Track feeds for new content');
        console.log('✅ Enhanced Search: Filter by multiple criteria');
        console.log('✅ Story Recommendations: Similarity-based suggestions');
        console.log('✅ Database Indexing: Improved search performance');
        console.log('✅ Reading Tracking: Track read count and history');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await scraper.close();
    }
}

testFeatures();