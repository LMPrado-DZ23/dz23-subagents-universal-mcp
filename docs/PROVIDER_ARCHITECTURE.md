# Registro de providers e configuração

Este inventário foi gerado do código v4.0.0, sem chamadas de rede e sem valores de
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
| `huggingface` | OpenAI-compatible | `HUGGINGFACE_TOKEN` (genérica: `HF_TOKEN`) | `https://router.huggingface.co/v1` | `deepseek-ai/DeepSeek-R1:fastest` | free-tier |
| `together` | OpenAI-compatible | `TOGETHER_API_KEY` | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | mixed |
| `fireworks` | OpenAI-compatible | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | mixed |
| `cerebras` | OpenAI-compatible | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | `llama-3.3-70b` | free-tier |
| `mistral` | OpenAI-compatible | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | `mistral-large-latest` | mixed |
| `xai` | OpenAI-compatible | `XAI_API_KEY` | `https://api.x.ai/v1` | `grok-4` | paid |
| `perplexity` | OpenAI-compatible | `PERPLEXITY_API_KEY` | `https://api.perplexity.ai` | `sonar` | paid |
| `github` | OpenAI-compatible | `GITHUB_MODELS_TOKEN` (genérica: `GITHUB_TOKEN`) | `https://models.inference.ai.azure.com` | `gpt-4o-mini` | free-tier |
| `sambanova` | OpenAI-compatible | `SAMBANOVA_API_KEY` | `https://api.sambanova.ai/v1` | `Meta-Llama-3.3-70B-Instruct` | free-tier |
| `nvidia` | OpenAI-compatible | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | `` | free-tier |
| `novita` | OpenAI-compatible | `NOVITA_API_KEY` | `https://api.novita.ai/v3/openai` | `` | mixed |
| `upstage` | OpenAI-compatible | `UPSTAGE_API_KEY` | `https://api.upstage.ai/v1` | `solar-pro2` | mixed |
| `ollama` | OpenAI-compatible | `OLLAMA_API_KEY` | `https://ollama.com/v1` | `` | mixed |
| `hyperbolic` | OpenAI-compatible | `HYPERBOLIC_API_KEY` | `https://api.hyperbolic.xyz/v1` | `` | mixed |
| `alibaba` | OpenAI-compatible | `ALIBABA_API_KEY` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | mixed |
| `cloudflare` | OpenAI-compatible | `CLOUDFLARE_API_TOKEN` (genérica: `CLOUDFLARE_AUTH_TOKEN`) | `` | `@cf/openai/gpt-oss-120b` | free-tier |
| `custom` | OpenAI-compatible | `CUSTOM_API_KEY` | `http://127.0.0.1:11434/v1` | `qwen3-coder` | local |
| `lmstudio` | OpenAI-compatible | `LMSTUDIO_API_KEY` | `http://127.0.0.1:1234/v1` | `local-model` | local |
| `vllm` | OpenAI-compatible | `VLLM_API_KEY` | `http://127.0.0.1:8000/v1` | `local-model` | local |

Cloudflare usa CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_BASE_URL. O endpoint da tabela
fica vazio enquanto a conta não é configurada. Alibaba usa variáveis próprias,
não sobrescreve as de OpenAI. O nome `ollama` refere-se ao endpoint cloud; Ollama
local usa `custom` com endpoint local. LM Studio e vLLM também exigem servidor rodando.

`DZ23_<PROVIDER>_BASE_URL` e `DZ23_<PROVIDER>_MODEL` (provider em maiúsculas) sobrescrevem as
sugestões e têm precedência sobre os nomes antigos `<PROVIDER>_BASE_URL`/`<PROVIDER>_MODEL`. Para
`openai` e `anthropic` só valem os nomes com prefixo: `OPENAI_BASE_URL`, `OPENAI_MODEL`,
`ANTHROPIC_BASE_URL` e `ANTHROPIC_MODEL` são ignorados. `http://` só é aceito para loopback ou rede
privada; os demais endereços exigem HTTPS. `<CHAVE>_FILE` lê um arquivo de segredo; arquivo ilegível
falha explicitamente. Together aceita o alias TogetherAIAPI_KEY.

Credenciais genéricas (`GITHUB_TOKEN`, `HF_TOKEN`, `CLOUDFLARE_AUTH_TOKEN`) só habilitam o provider
quando `DZ23_ROTATION` o cita ou com `DZ23_ALLOW_GENERIC_CREDENTIALS=true`; caso contrário o inventário
mostra `ignored_credential_source` com o nome da variável. `discover_models` só consulta providers
habilitados.

## Categoria de roteamento e política de custo

Sem `DZ23_ALLOW_PAID=true`: `paid` e `low-cost` são pulados (`paid_not_allowed`); `mixed` é pulado
(`mixed_not_allowed`), exceto quando o id do modelo termina em `:free` ou `provider:modelo` está em
`DZ23_FREE_MODELS`; `local` e `free-tier` são permitidos. Um adapter local (`custom`, `lmstudio`,
`vllm`) apontado para host que não é loopback nem rede privada passa a `mixed`. `doctor` mostra cada
alvo com tier e motivo; `providers` inclui a coluna `TIER`.

## Estados de um provider

`provider_inventory.status_flags` separa quatro fatos que antes se confundiam:

| Flag | Significa | Não significa |
| --- | --- | --- |
| `configured` | Endpoint e modelo definidos | credencial válida |
| `credential_present` | Valor de credencial encontrado (`credential_required` indica se é necessária) | autorização no fornecedor |
| `catalog_discovered` | Última consulta a `/models` teve sucesso | acesso à inferência |
| `inference_verified` | Última `verify_model` gerou texto | disponibilidade futura ou quota restante |

`discover_models` persiste o resultado do catálogo; `verify_model` persiste
`last_verified_at`, `last_success_at`, latência e o último tipo de erro. Nenhuma verificação
cobrável roda na inicialização.

## Erros, retry e cooldown

Falhas são classificadas em `rate_limited`, `quota_exhausted`, `billing_required`,
`authentication_failed`, `permission_denied`, `model_not_found`, `endpoint_not_found`,
`context_length_exceeded`, `provider_timeout`, `provider_unavailable`, `invalid_request`,
`response_invalid`, `provider_error` e `configuration_error`, a partir do status HTTP e de padrões no
corpo (que nunca é devolvido ou gravado).

- Retry no mesmo alvo apenas para `rate_limited`, `provider_timeout` e `provider_unavailable`
  (`DZ23_MAX_RETRIES`, padrão 1; backoff exponencial a partir de `DZ23_RETRY_BASE_DELAY_MS`;
  `Retry-After` respeitado até `DZ23_RETRY_AFTER_CAP_MS`, acima disso vai direto ao failover).
- `context_length_exceeded`: HTTP 413, ou 400/422 cujo corpo diz que o contexto/prompt é longo demais.
  Não é repetido, faz failover para o próximo alvo (que pode ter janela maior) e não gera cooldown.
  Um 413 só é `rate_limited` quando o corpo fala de rate limit sem dizer que a requisição é grande ou
  longa demais (por exemplo "Rate limit reached"). "Request too large ... tokens per minute (TPM)"
  continua `context_length_exceeded`: aquela requisição nunca cabe no limite daquele alvo.
- `invalid_request` (400/422 sem sinal de modelo ou de contexto) não é repetido nem enviado a outros
  providers.
- Cooldown: 60 s para `rate_limited`, `response_invalid` e `provider_error`; 30 s para timeout e
  indisponibilidade; 15 min para quota, cobrança, autenticação, permissão, modelo, endpoint e
  configuração; nenhum para `invalid_request` e `context_length_exceeded`. Um `Retry-After` maior
  prolonga o cooldown.
- Com `DZ23_SHARED_COOLDOWNS=true` (padrão), cooldowns de rate limit, quota e falhas de autenticação
  são persistidos em `<estado>/providers/status.json`; outros processos que usam o mesmo diretório
  (Claude Code, Codex, Hermes) pulam o alvo até o fim do cooldown.

## Capabilities

O adapter expõe texto não-streaming. `capabilities` descreve essa superfície: vision, tools,
embeddings e streaming são `false` porque não são expostos, mesmo que o fornecedor os ofereça.
`catalog_capabilities` reproduz o que o catálogo declara (modalidades, parâmetros suportados,
contexto e limite de saída) e usa `unknown` quando o catálogo não informa. Coding/reasoning não são
benchmarkados. ElevenLabs e Deepgram não são adapters desta versão.

A classificação de custo é estática: mixed/free-tier não certifica uso gratuito. A chave ausente
desabilita cloud; alvos explícitos precisam estar na rotação quando DZ23_ROTATION tiver lista.
Para inferência paga, low-cost ou mixed não declarada gratuita, `DZ23_ALLOW_PAID` deve ser habilitado
pelo operador, e o orçamento e os limites do fornecedor devem ser configurados.
