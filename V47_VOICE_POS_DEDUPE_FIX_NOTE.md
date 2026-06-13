# V47 Voice POS Dedupe Real Fix

Fix AI Voice POS mobile/tablet speech recognition duplicates.

Example before:
- Chiến
- Chiến xương ống 10 kg
- Chiến xương ống 10 kg

After:
- Chiến xương ống 10 kg

Patch file:
- frontend/src/components/ai/AIVoicePOSPanel.jsx

Logic:
- interim transcript is preview only
- final transcript is debounced
- shorter prefix is replaced by longer final sentence
- exact duplicate is ignored
