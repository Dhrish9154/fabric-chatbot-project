# Daily Update Checklist

1. Update the stock PDFs in `Downloads` with the latest quality files.
2. Run `node update_stock_from_pdfs.js` to refresh stock, colors, and color-wise stock in `data/catalog.json`.
3. Update `data/daily_updates.json` if you need manual stock adjustments or want to hide out-of-stock designs.
4. Run `node apply_daily_updates.js` to apply manual hides and overrides.
5. Run `node generate_catalog_pdfs.js` to regenerate and upload the latest catalog PDFs.
6. Restart the bot if your deployment setup does not hot-reload changes.
7. Check `data/stock_import_report.json` for missing catalog IDs or PDF mismatches.
8. Review `data/interaction_log.jsonl` to see which qualities, design codes, and sales intents customers are using most.
