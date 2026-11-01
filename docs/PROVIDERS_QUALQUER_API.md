# Qualquer API em um único `.env`

O roteador não depende de o provedor estar no catálogo. Qualquer endpoint compatível
com **OpenAI Chat Completions** ou **Anthropic Messages** entra pela declaração abaixo.

## O contrato

```dotenv
DZ23_PROVIDERS=minhaapi,equipe

# ── provedor 1 ──────────────────────────────────────────────
DZ23_MINHAAPI_BASE_URL=https://api.exemplo.com/v1
DZ23_MINHAAPI_API_KEY=sk-...
DZ23_MINHAAPI_MODEL=modelo-padrao
DZ23_MINHAAPI_PROTOCOL=openai        # openai (padrão) | anthropic
DZ23_MINHAAPI_TIER=mixed             # paid | low-cost | mixed | free-tier | local
DZ23_MINHAAPI_LABEL=Minha API        # opcional, só exibição

# ── provedor 2 (gateway interno, sem chave) ─────────────────
DZ23_EQUIPE_BASE_URL=http://10.0.0.5:8080/v1
DZ23_EQUIPE_TIER=local
DZ23_EQUIPE_MODEL=llama-3.3-70b
```

E para o roteador usá-los:

```dotenv
DZ23_ROTATION=minhaapi:modelo-padrao,equipe:llama-3.3-70b,openai:gpt-4o
```

## Regras

| Campo | Obrigatório | Observação |
|---|---|---|
| `DZ23_PROVIDERS` | sim | lista separada por vírgula; nomes normalizados para minúsculo |
| `DZ23_<NOME>_BASE_URL` | sim | HTTP(S) sem credenciais, query ou fragment |
| `DZ23_<NOME>_API_KEY` | em provedor de nuvem | vazio = provedor fica desligado |
| `DZ23_<NOME>_API_KEY_FILE` | alternativa | lê a chave do arquivo; melhor em servidor |
| `DZ23_<NOME>_MODEL` | recomendado | modelo padrão quando o alvo não traz `:modelo` |
| `DZ23_<NOME>_PROTOCOL` | não | `openai` (padrão) ou `anthropic` |
| `DZ23_<NOME>_TIER` | não | `mixed` por padrão; controla a política de custo |

## Segurança embutida

- **HTTP sem TLS é recusado** fora de loopback, IP privado ou host em `DZ23_PRIVATE_HOSTS`.
- Nome inválido, `BASE_URL` ausente, protocolo ou tier desconhecido **falham na inicialização**
  com mensagem explícita — não existe provedor meio-configurado.
- Provedor de nuvem sem chave simplesmente não liga; nada é chamado em vazio.
- `TIER=local` dispensa chave e libera HTTP privado, como os adaptadores `custom`/`vllm`.

## Exemplos reais

| Serviço | Configuração |
|---|---|
| OpenRouter | já vem no catálogo — só `OPENROUTER_API_KEY` |
| Ollama local | `DZ23_PROVIDERS=ollama_local` + `BASE_URL=http://127.0.0.1:11434/v1` + `TIER=local` |
| vLLM no servidor da equipe | `BASE_URL=http://10.0.0.5:8000/v1` + `TIER=local` |
| Revenda de API | `BASE_URL=https://revenda.exemplo/v1` + `API_KEY` + `TIER=paid` |
| Gateway com auth Anthropic | `PROTOCOL=anthropic` + `BASE_URL=https://gateway.exemplo` |

## Diferença para `CUSTOM_*`

`custom`, `lmstudio`, `vllm` e `omniroute` são adaptadores locais fixos, um por endpoint.
A declaração genérica permite **quantos provedores quiser**, cada um com seu protocolo,
tier e modelo padrão, sem tocar no código.
