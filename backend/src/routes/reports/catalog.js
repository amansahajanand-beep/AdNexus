const express = require('express');
const router = express.Router();
const { handleFilterCatalog, handleCountries } = require('../../services/reportCore');

router.get('/filter-catalog', handleFilterCatalog);
router.get('/countries', handleCountries);

module.exports = router;
