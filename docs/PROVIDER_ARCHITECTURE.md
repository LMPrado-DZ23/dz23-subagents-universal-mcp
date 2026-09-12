# Registro de providers e configuração

Este inventário foi gerado do código v2.2.5, sem chamadas de rede e sem valores de
credencial. Endpoints/modelos sugeridos são configuração, não prova de serviço
atual, gratuidade, autenticação ou entitlement. Descubra/valide modelos na sua conta.
Um campo de modelo vazio exige MODEL configurado ou alvo provider:model explícito.

| Provider | Adapter | Chave | Base URL configurada | Modelo sugerido | Categoria de roteamento |
| --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI-compatible | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o` | paid |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` | `` | paid |
| `gemini` | OpenAI-compatible | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | `` | mixed |
| `openrouter` | OpenAI-compatible | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `openrouter/auto` | mixed |
| `deepseek` | OpenAI-compatible | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` | low-cost |
| `groq` | OpenAI-compatible | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | free-tier |
| `huggingface` | OpenAI-compatible | `HUGGINGFACE_TOKEN` | `https://router.huggingface.co/v1` | `deepseek-ai/DeepSeek-R1:fastest` | free-tier |
| `together` | OpenAI-compatible | `TOGETHER_API_KEY` | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | mixed |
| `fireworks` | OpenAI-compatible | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | mixed |
| `cerebras` | OpenAI-compatible | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | free-tier |
| `mistral` | OpenAI-compatible | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | `mistral-large-latest` | mixed |
| `xai` | OpenAI-compatible | `XAI_API_KEY` | `https://api.x.ai/v1` | `grok-4` | paid |
| `perplexity` | OpenAI-compatible | `PERPLEXITY_API_KEY` | `https://api.perplexity.ai` | `sonar` | paid |
| `github` | OpenAI-compatible | `GITHUB_TOKEN` | `https://models.inference.ai.azure.com` | `gpt-4o-mini` | free-tier |
| `sambanova` | OpenAI-compatible | `SAMBANOVA_API_KEY` | `https://api.sambanova.ai/v1` | `Meta-Llama-3.3-70B-Instruct` | free-tier |
| `nvidia` | OpenAI-compatible | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | `` | free-tier |
| `novita` | OpenAI-compatible | `NOVITA_API_KEY` | `https://api.novita.ai/v3/openai` | `` | mixed |
| `upstage` | OpenAI-compatible | `UPSTAGE_API_KEY` | `https://api.upstage.ai/v1` | `solar-pro2` | mixed |
| `ollama` | OpenAI-compatible | `OLLAMA_API_KEY` | `https://ollama.com/v1` | `` | mixed |
| `hyperbolic` | OpenAI-compatible | `HYPERBOLIC_API_KEY` | `https://api.hyperbolic.xyz/v1` | `` | mixed |
| `alibaba` | OpenAI-compatible | `ALIBABA_API_KEY` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | mixed |
| `cloudflare` | OpenAI-compatible | `CLOUDFLARE_API_TOKEN` | `` | `@cf/openai/gpt-oss-120b` | free-tier |
| `custom` | OpenAI-compatible | `CUSTOM_API_KEY` | `http://127.0.0.1:11434/v1` | `qwen3-coder` | local |
| `lmstudio` | OpenAI-compatible | `LMSTUDIO_API_KEY` | `http://127.0.0.1:1234/v1` | `local-model` | local |
| `vllm` | OpenAI-compatible | `VLLM_API_KEY` | `http://127.0.0.1:8000/v1` | `local-model` | local |

Cloudflare usa CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_BASE_URL. O endpoint da tabela
fica vazio enquanto a conta não é configurada. Alibaba usa variáveis próprias,
não sobrescreve as de OpenAI. O nome `ollama` refere-se ao endpoint cloud; Ollama
local usa `custom` com endpoint local. LM Studio e vLLM também exigem servidor rodando.

`PROVIDER_BASE_URL` e `PROVIDER_MODEL` (provider em maiúsculas) sobrescrevem sugestões.
`KEY_FILE` lê um arquivo de segredo; arquivo ilegível falha explicitamente. Together
aceita o alias TogetherAIAPI_KEY; Hugging Face aceita HF_TOKEN.

`provider_inventory` relata CONFIGURED e campos faltantes, não READY autenticado.
`list_models` mostra alvos de roteamento; `discover_models` consulta catálogo com
cache de cinco minutos; `health_check` faz inferência textual real e pode consumir
créditos. Catálogo não comprova acesso a cada modelo; formatos/paginação variam por
serviço e não existe garantia de catálogo exaustivo.

O adapter expõe texto não-streaming. Coding/reasoning dependem do modelo e não são
benchmarkados. Vision, tools, embeddings, áudio e streaming não estão expostos,
mesmo que o fornecedor os suporte em outras APIs. ElevenLabs e Deepgram não são
LLM adapters desta versão. O registro genérico evita duplicação de adapters.

A classificação de custos é estática: mixed/free-tier não certifica uso gratuito.
A chave ausente desabilita cloud; alvos explicitamente configurados ainda precisam
estar na rotação quando DZ23_ROTATION tiver uma lista. Para inferência paga/low-cost,
ALLOW_PAID deve ser habilitado pelo operador e o fornecedor deve impor limites.
