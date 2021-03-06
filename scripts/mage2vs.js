const program = require('commander')
const config = require('config')
const spawn = require('child_process').spawn

function multiStoreConfig(apiConfig, storeCode) {
  let confCopy = Object.assign({}, apiConfig)

  if (storeCode && config.availableStores.indexOf(storeCode) >= 0)
  {
      if (config.magento2['api_' + storeCode]) {
          confCopy = Object.assign({}, config.magento2['api_' + storeCode]) // we're to use the specific api configuration - maybe even separate magento instance
      }
      confCopy.url = confCopy.url + '/' + storeCode
  } else {
      if (storeCode) {
          console.error('Unavailable store code', storeCode)
      }
  }
  return confCopy
}

function getMagentoDefaultConfig(storeCode) {
  const apiConfig = multiStoreConfig(config.magento2.api, storeCode)
  return {
    TIME_TO_EXIT: 2000,
    PRODUCTS_SPECIAL_PRICES: true,
    SKIP_REVIEWS: false,
    SKIP_CATEGORIES: false,
    SKIP_PRODUCTCATEGORIES: false,
    SKIP_ATTRIBUTES: false,
    SKIP_TAXRULE: false,
    SKIP_PRODUCTS: false,
    PRODUCTS_EXCLUDE_DISABLED: config.catalog.excludeDisabledProducts,
    MAGENTO_CONSUMER_KEY: apiConfig.consumerKey,
    MAGENTO_CONSUMER_SECRET: apiConfig.consumerSecret,
    MAGENTO_ACCESS_TOKEN: apiConfig.accessToken,
    MAGENTO_ACCESS_TOKEN_SECRET: apiConfig.accessTokenSecret,
    MAGENTO_URL: apiConfig.url,
    REDIS_HOST: config.redis.host,
    REDIS_PORT: config.redis.port,
    REDIS_DB: config.redis.db,
    INDEX_NAME: config.elasticsearch.indices[0],
    DATABASE_URL: `${config.elasticsearch.protocol}://${config.elasticsearch.host}:${config.elasticsearch.port}`
  }
}

function exec(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let child = spawn(cmd, args, opts)
    child.stdout.on('data', (data) => {
      console.log(data.toString('utf8'));
    });

    child.stderr.on('data', (data) => {
      console.log(data.toString('utf8'));
    });

    child.on('close', (code) => {
      resolve(code)
    });

    child.on('error', (error) => {
      console.error(error)
      reject(error)
    });
  })
}

program
  .command('productsdelta')
  .option('--store-code <storeCode>', 'storeCode in multistore setup', null)
  .option('--adapter <adapter>', 'name of the adapter', 'magento')
  .option('--partitions <partitions>', 'number of partitions', 1)
  .option('--partitionSize <partitionSize>', 'size of the partitions', 200)
  .option('--initQueue <initQueue>', 'use the queue', true)
  .option('--skus <skus>', 'comma delimited list of SKUs to fetch fresh informations from', '')
  .option('--removeNonExistent <removeNonExistent>', 'remove non existent products', false)
  .action((cmd) => {
    let magentoConfig = getMagentoDefaultConfig(cmd.storeCode)
    magentoConfig.MAGENTO_STORE_ID = 1
    magentoConfig.INDEX_META_PATH = '.lastIndex.json'

    if (cmd.storeCode) {
      const storeView = config.storeViews[cmd.storeCode]
      if (!storeView) {
        console.error('Wrong storeCode provided - no such store in the config.storeViews[storeCode]', cmd.storeCode)
        process.exit(-1)
      } else {
        magentoConfig.INDEX_NAME = storeView.elasticsearch.index
        magentoConfig.INDEX_META_PATH = '.lastIndex-' + cmd.storeCode + '.json'
        magentoConfig.MAGENTO_STORE_ID = storeView.storeId
      }
    }

    const env = Object.assign({}, magentoConfig, process.env)  // use process env as well
    console.log('=== Delta indexer is about to start ===')

    exec('node', [
      '--harmony',
      'node_modules/mage2vuestorefront/src/cli.js',
      'productsdelta',
      '--adapter=' + cmd.adapter,
      '--partitions=' + cmd.partitions,
      '--partitionSize=' + cmd.partitionSize,
      '--initQueue=' + cmd.initQueue,
      '--skus=' + cmd.skus,
      '--removeNonExistent=' + cmd.removeNonExistent
    ], { env: env, shell: true }).then((res) => {

    })

  })

program
  .command('import')
  .option('--store-code <storeCode>', 'storeCode in multistore setup', null)
  .option('--skip-reviews <skipReviews>', 'skip import of reviews', false)
  .option('--skip-categories <skipCategories>', 'skip import of categories', false)
  .option('--skip-productcategories <skipProductcategories>', 'skip import of productcategories', false)
  .option('--skip-attributes <skipAttributes>', 'skip import of attributes', false)
  .option('--skip-taxrule <skipTaxrule>', 'skip import of taxrule', false)
  .option('--skip-products <skipProducts>', 'skip import of products', false)
  .action((cmd) => {
    let magentoConfig = getMagentoDefaultConfig(cmd.storeCode)

    if (cmd.storeCode) {
      const storeView = config.storeViews[cmd.storeCode]
      if (!storeView) {
        console.error('Wrong storeCode provided - no such store in the config.storeViews[storeCode]', cmd.storeCode)
        process.exit(-1)
      } else {
        magentoConfig.INDEX_NAME = storeView.elasticsearch.index;
        magentoConfig.MAGENTO_STORE_ID = storeView.storeId;
      }
    }

    if (cmd.skipReviews) {
      magentoConfig.SKIP_REVIEWS = true;
    }
    if (cmd.skipCategories) {
      magentoConfig.SKIP_CATEGORIES = true;
    }
    if (cmd.skipProductcategories) {
      magentoConfig.SKIP_PRODUCTCATEGORIES = true;
    }
    if (cmd.skipAttributes) {
      magentoConfig.SKIP_ATTRIBUTES = true;
    }
    if (cmd.skipTaxrule) {
      magentoConfig.SKIP_TAXRULE = true;
    }
    if (cmd.skipProducts) {
      magentoConfig.SKIP_PRODUCTS = true;
    }

    const env = Object.assign({}, magentoConfig, process.env)  // use process env as well
    console.log('=== The mage2vuestorefront full reindex is about to start. Using the following Magento2 config ===', magentoConfig)

    let createDbPromise = function() {

      console.log(' == CREATING NEW DATABASE ==')
      return exec('node', [
        'scripts/db.js',
        'new',
        `--indexName=${env.INDEX_NAME}`
      ], { env: env, shell: true })

    }

    let importReviewsPromise = function() {
      if (magentoConfig.SKIP_REVIEWS ) {
        return Promise.resolve();
      }
      else {
        console.log(' == REVIEWS IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'reviews'
        ], {env: env, shell: true})
      }
    }

    let importCategoriesPromise = function() {
      if (magentoConfig.SKIP_CATEGORIES ) {
        return Promise.resolve();
      }
      else {
        console.log(' == CATEGORIES IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'categories',
          '--removeNonExistent=true',
          '--extendedCategories=true'
        ], { env: env, shell: true })
      }
    }

    let importProductcategoriesPromise = function() {
      if (magentoConfig.SKIP_PRODUCTCATEGORIES ) {
        return Promise.resolve();
      }
      else {
        console.log(' == PRODUCT-CATEGORIES IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'productcategories'
        ], { env: env, shell: true })
      }
    }

    let importAttributesPromise = function() {
      if (magentoConfig.SKIP_ATTRIBUTES ) {
        return Promise.resolve();
      }
      else {
        console.log(' == ATTRIBUTES IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'attributes',
          '--removeNonExistent=true'
        ], { env: env, shell: true })
      }
    }

    let importTaxrulePromise = function() {
      if (magentoConfig.SKIP_TAXRULE ) {
        return Promise.resolve();
      }
      else {
        console.log(' == TAXRULE IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'taxrule',
          '--removeNonExistent=true'
        ], { env: env, shell: true })
      }
    }

    let importProductsPromise = function() {
      if (magentoConfig.SKIP_PRODUCTS ) {
        return Promise.resolve();
      }
      else {
        console.log(' == PRODUCTS IMPORTER ==');
        return exec('node', [
          '--harmony',
          'node_modules/mage2vuestorefront/src/cli.js',
          'products',
          '--removeNonExistent=true',
          '--partitions=1'
        ], { env: env, shell: true })
      }
    }

    let reindexPromise = function() {
      console.log(' == REINDEXING DATABASE ==')
      return exec('node', [
        'scripts/db.js',
        'rebuild',
        `--indexName=${env.INDEX_NAME}`
      ], {env: env, shell: true})
    }

    createDbPromise().then( () => {
      importReviewsPromise().then( () => {
        importCategoriesPromise().then( () => {
          importProductcategoriesPromise().then( () => {
            importAttributesPromise().then(() => {
              importTaxrulePromise().then(() => {
                importProductsPromise().then (() => {
                  reindexPromise().then( () => {
                        console.log('Done! Bye Bye!')
                        process.exit(0)
                  })
                })
              })
            })
          })
        })
      })
    })
  });


program
  .on('command:*', () => {
    console.error('Invalid command: %s\nSee --help for a list of available commands.', program.args.join(' '));
    process.exit(1);
  });

program
  .parse(process.argv)

process.on('unhandledRejection', (reason, p) => {
  console.log("Unhandled Rejection at: Promise ", p, " reason: ", reason)
})

process.on('uncaughtException', function(exception) {
  console.log(exception)
})
