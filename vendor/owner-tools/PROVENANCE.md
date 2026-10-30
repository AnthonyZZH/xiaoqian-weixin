# Sources and provenance

This independent module was authored for the Xiaoqian native Harness integration.
It does not contain provider keys, production settings, private chats, memory,
downloaded user files, copied model prompts or third-party runtime code.

- DeepSeek's official balance contract was checked on 2026-10-29:
  https://api-docs.deepseek.com/api/get-user-balance/
- Public search uses HTML responses from DuckDuckGo and Bing through Python's
  standard HTTP library. No paid Search/Fetch API or external scraping library.
- DOCX parsing uses Python standard-library ZIP and XML readers; no document
  rendering engine, macros, Office automation or external document SDK.
- Native registration follows the already inspected local rc.4 defineTool
  contract. No Harness implementation code is redistributed here.

All tests and balance/document examples are synthetic. Mock isolation receipts
are deliberately labelled synthetic and are not claims about the server's OS.
