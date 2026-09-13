# Roadmap — metas, não funcionalidades entregues

Entregue na 2.3.0 e fora deste roadmap: validação de schemas, erros JSON-RPC, negociação de
versão, token por arquivo e escopos, rate limit por processo, logs/métricas, taxonomia de erros,
orçamento, diversidade de roteamento, `verify_model`, memória versionada e CLI operacional.

Prioridade 1: contrato com SDKs/clientes MCP oficiais em CI, Streamable HTTP com SSE e sessões,
OAuth para uso remoto e limites/orçamento compartilhados entre processos.

Prioridade 2: memória transacional (por exemplo SQLite com WAL e migrações), isolamento de projetos
por identidade, retenção configurável e busca seletiva no contexto.

Prioridade 3: autorização de execução em sandbox/worktrees, task DAG, integração verificável de
patches/testes, idempotência e checkpoints de ações reais.

Prioridade 4: preços mantidos por fonte verificável, benchmarks de qualidade/custo/latência e
capabilities por modelo validadas por testes, não apenas por catálogo.

Prioridade 5: multimodalidade (vision, speech, embeddings) e streaming de saída, com controles e
testes específicos. Credencial de um serviço não equivale a adapter.

Não apresentar estes itens como existentes em releases, README ou inventário.
