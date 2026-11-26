-- Model-call spans were labelled 'gemini'; the provider is now OpenAI, so the category is provider-neutral.
update trace_spans set category = 'llm' where category = 'gemini';
