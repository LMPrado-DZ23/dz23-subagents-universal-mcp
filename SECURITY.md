# Security policy / Política de segurança

Esta é uma prévia de engenharia para uso por um operador/equipe confiável.
Não há certificação de segurança, pentest independente ou isolamento multitenant.
A versão preparada nesta entrega é 2.2.5; versões anteriores não recebem promessa
automática de backport ou SLA.

## Relatar um problema

Use o recurso de relato privado de vulnerabilidade do GitHub quando estiver
habilitado. Se não houver canal privado disponível, abra somente uma solicitação
sem detalhes sensíveis pedindo um canal ao mantenedor. Não publique credenciais,
dados pessoais, conteúdo de projetos ou uma demonstração contra sistemas de terceiros.
Teste exclusivamente cópias locais/ambientes autorizados com dados sintéticos.

## Limites

- Uma instância = um domínio de confiança. `project_id` não é uma barreira de autorização.
- Proteja o diretório de memória e seus backups; ele pode conter código e dados privados.
- HTTP permanece desativado por padrão. Se habilitado, exige TLS no proxy e token privado;
  não há OAuth, RBAC ou validação por usuário.
- Configure limites de conexão/rate limit no proxy; não exponha a instância para público hostil.
- Não conceda shell irrestrito a agentes. O MCP retorna texto; permissões de execução são do host.
- Entrada/saída de modelo é não confiável. Revise propostas antes de aplicá-las.
- `free-first` não garante gratuidade. Defina limites de gastos e acesso a modelos no provider.
- Não use chaves de produção em testes, issues, CI ou exemplos públicos.

## Controles desta versão

Bloqueio de alvo pago/low-cost também na seleção explícita; limites de chamadas e fila;
papéis em enum estrito; contexto persistido rotulado como não confiável; limites de
resposta, frame stdio e retenção; IDs estritos para memória; novas permissões restritas;
erros HTTP de providers sem corpo bruto; validação de Host/Origin; token obrigatório
em bind não local; allowlist/hash e scanner por padrões no fluxo de publicação.

Esses controles reduzem riscos específicos, mas não justificam a afirmação de
que o sistema é seguro em qualquer ambiente. Consulte docs/ARCHITECTURE.md para os
limites de crash, locks, contexto e concorrência distribuída.
