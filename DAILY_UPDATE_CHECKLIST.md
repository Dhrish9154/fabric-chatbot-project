# Daily Update Checklist

1. Update the stock PDFs in `Downloads` with the latest quality files.
2. Run `node update_stock_from_pdfs.js` to refresh stock, colors, and color-wise stock in `data/catalog.json`.
3. Update `data/daily_updates.json` if you need manual stock adjustments or want to hide out-of-stock designs.
4. Run `node apply_daily_updates.js` to apply manual hides and overrides.
5. Run `node generate_catalog_pdfs.js` to regenerate and upload the latest catalog PDFs.
6. Restart the bot if your deployment setup does not hot-reload changes.
7. Check `data/stock_import_report.json` for missing catalog IDs or PDF mismatches.
8. Review `data/interaction_log.jsonl` to see which qualities, design codes, and sales intents customers are using most.

## Render + WhatsApp Go-Live Order

1. Create the permanent Meta Developer account and WhatsApp app.
2. Deploy the bot on Render from the GitHub repository.
3. Add the Render webhook URL in Meta: `https://your-render-app.onrender.com/webhook`.
4. Test the bot with Meta's test WhatsApp number first.
5. Add or migrate the real WhatsApp business number after the test flow works.
6. Update Render environment variables with the real `PHONE_NUMBER_ID`, token, verify token, and business settings.

## WhatsApp Welcome Template

Use these values in Meta WhatsApp Manager:

- Template name: `tianso_welcome`
- Category: `Marketing`
- Language: `English`
- Body: `Welcome to Tianso Global. Choose an option below to view our latest premium shirting fabric collections.`
- Quick reply button 1: `View Fabrics`
- Quick reply button 2: `Contact Sales`

After Meta approves the template, send it with:

```powershell
npm run send-welcome-template -- 91XXXXXXXXXX
```
