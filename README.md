# Funnel Analyzer

Automated marketing funnel analysis tool that reads campaign data from Google Sheets, calculates key metrics, generates AI-powered insights via Claude, and delivers reports to Telegram.

## What it does

- Reads live campaign data from Google Sheets
- Calculates CTR, CAC, and ROMI for each campaign
- Uses Claude AI to interpret results and generate recommendations
- Sends formatted reports to Telegram on demand or automatically

## Commands (Telegram Bot)

| Command | Description |
|---|---|
| `/звіт` | Full report with AI analysis |
| `/топ` | Top 3 campaigns by ROMI |
| `/стоп` | Campaigns with negative ROMI to pause |

## Tech stack

- Node.js
- Claude AI (Anthropic SDK)
- Google Sheets API
- Telegram Bot API

## Metrics calculated

- **CTR** — Click-Through Rate (clicks / impressions)
- **CAC** — Customer Acquisition Cost (spend / conversions)
- **ROMI** — Return on Marketing Investment ((revenue − spend) / spend)
