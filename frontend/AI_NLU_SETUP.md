# MeatBiz Real AI NLU Setup

This adds an optional real AI understanding layer before the old regex parser.

## .env

```env
OPENAI_API_KEY=your_key_here
OPENAI_NLU_MODEL=gpt-4o-mini
```

## How it works

Text/voice message
→ LLM extracts JSON intent
→ existing validated MeatBiz business engine executes
→ DB transaction

The LLM never writes to DB directly.

## Examples

```text
chị Hiền lấy thêm ít bon với 2 ký nầm
HongHien chuyển khoản 2 triệu
chị Sơn còn nợ bao nhiêu
thêm một ký gầu
bỏ bon
ok lưu
```

If no API key is configured, all old rule-based features still work.


## Speech / terminal typo tolerance

This build normalizes several common Vietnamese encoding glitches before NLU, for example:

```text
ch介 -> chi
Hi仁n -> Hien
l亥y -> lay
v仛i -> voi
n产m -> nam
```

So a noisy input such as:

```text
ch介 Hi仁n l亥y thêm ít bon v仛i 2 ký n产m
```

is normalized before AI/business parsing.

## Timeout fallback

This build never blocks MeatBiz if OpenAI is unreachable.

Optional timeout setting:

```env
OPENAI_NLU_TIMEOUT_MS=8000
```

If OpenAI times out, `/api/ai/chat` automatically falls back to the local rule parser.
