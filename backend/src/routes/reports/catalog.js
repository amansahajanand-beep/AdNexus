const express = require('express');
const router = express.Router();
const { handleFilterCatalog, handleCountries } = require('../../services/reportCore');
const { bindRequestClient } = require('../../utils/clientContext');

router.get('/filter-catalog', bindRequestClient(handleFilterCatalog));
router.get('/countries', bindRequestClient(handleCountries));

module.exports = router;
