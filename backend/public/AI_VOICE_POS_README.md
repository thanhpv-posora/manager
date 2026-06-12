# MeatBiz AI Voice POS

Mở trên trình duyệt:

```text
http://localhost:4000/ai-voice-pos.html
```

Câu test:

```text
HongHien 5 Bon 2 Nam
thêm 1 Gau
ok lưu
doanh thu hôm nay
HongHien còn nợ bao nhiêu
HongHien trả 500k
ok thu
```

Chrome/Edge hỗ trợ giọng nói tiếng Việt tốt nhất.


## Real AI NLU mode

Add this to `.env` to enable LLM-based Vietnamese understanding:

```env
OPENAI_API_KEY=your_key_here
OPENAI_NLU_MODEL=gpt-4o-mini
```

Without `OPENAI_API_KEY`, the app automatically falls back to the existing rule-based parser.
