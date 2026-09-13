# Security policy / Política de segurança

Esta é uma prévia de engenharia para uso por um operador ou equipe confiável.
Não há certificação de segurança, pentest independente ou isolamento multitenant.
A versão preparada nesta entrega é 3.0.0; versões anteriores não recebem promessa
automática de backport ou SLA.

## Relatar um problema

Use o recurso de relato privado de vulnerabilidade do GitHub quando estiver
habilitado. Se não houver canal privado disponível, abra somente uma solicitação
sem detalhes sensíveis pedindo um canal ao mantenedor. Não publique credenciais,
dados pessoais, conteúdo de projetos ou uma demonstração contra sistemas de terceiros.
Teste exclusivamente cópias locais/ambientes autorizados com dados sintéticos.

## Limites

- Uma instância = um domínio de confiança. `project_id` não é autenticação nem autorização.
  O modo `scoped` restringe ferramentas por token, não isola projetos entre clientes.
- Proteja o diretório de memória e seus backups; ele pode conter código e dados privados.
- HTTP permanece desativado por padrão. Se habilitado fora de loopback, exige token de 32+
  caracteres (ou tokens com escopo) e TLS no proxy; não há OAuth.
- Rate limit, orçamento e métricas são por processo; várias réplicas não compartilham contadores.
- Não conceda shell irrestrito a agentes. O MCP retorna texto; permissões de execução são do host.
- Entrada/saída de modelo é não confiável. Revise propostas antes de aplicá-las.
- `free-first` não garante gratuidade. Configure orçamento e limites de gasto no fornecedor.
- Não use chaves de produção em testes, issues, CI ou exemplos públicos.

## Controles desta versão

- Validação de todos os argumentos contra schemas fechados, com limites de tamanho.
- JSON-RPC padronizado, sem stack trace, corpo cru de provider ou prompt nos erros.
- Token por arquivo, escopos por token com digest SHA-256 comparado em tempo constante,
  Host (pelo header)/Origin, bloqueio de requisições cross-site de navegador, rotas faturáveis só
  por POST com confirmação, rate limit (falhas de autenticação limitadas sem bloquear tokens
  válidos) e limites de corpo, tempo, conexões e requisições em andamento.
- Logs JSONL com redação de chaves sensíveis, padrões de credenciais e valores configurados.
- Taxonomia de erros de provider sem conteúdo externo; retry limitado e sem failover para
  requisições inválidas.
- Orçamento verificado antes de cada chamada; custo desconhecido explícito e configurável.
- `health_check`, `verify_model` e `health --yes` exigem confirmação explícita de possível cobrança;
  provedores locais só ficam ativos com configuração explícita.
- Memória com integridade verificada, locks com dono e reparo que nunca apaga dados.
- Publicação com allowlist/hash, scanner de padrões e auditoria dos arquivos rastreados.

Esses controles reduzem riscos específicos, mas não justificam a afirmação de que o sistema
é seguro em qualquer ambiente. Consulte docs/ARCHITECTURE.md e docs/OPERATIONS.md.
