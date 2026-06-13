# V46 Patch Notes

- Patched `frontend/src/components/ai/AIVoicePOSPanel.jsx` to process only stabilized final voice transcript and prevent duplicated partial lines such as `Chiến`, `Chiến xương`, `Chiến xương ống`.
- Patched lot save validation in frontend and backend: cannot save lot without supplier, raw weight, animal count, or positive final weight.
- Kept debtor anonymization on Home/Landing only. Dashboard AI components now show real customer names.
