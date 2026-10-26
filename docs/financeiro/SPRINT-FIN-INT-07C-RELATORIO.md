# Sprint FIN-INT-07C — Correção da autorização multiempresa do dry-run

**Tipo:** correção focada de autorização multiempresa  
**Data:** 2026-10-26  
**Homologação:** aguardando Tech Lead

## 1. Resumo

O dry-run histórico de Contas a Pagar agora limita a consulta às empresas com vínculo ativo e empresa ativa para o usuário autenticado. O papel administrativo continua obrigatório, mas não concede acesso global. As duas flags multiempresa usam a lista autorizada; a consulta individual também verifica que a empresa do contexto consta nessa lista antes de executar o dry-run.

Quando o contexto está ausente ou não autorizado, o middleware rejeita a solicitação antes da execução do relatório. Quando não há empresas autorizadas, a rota também responde `403` sem chamar o serviço.

## 2. Arquivos alterados

- `backend/rotas/contas_pagar.js`
  - Consulta `UsuarioEmpresaService.listarEmpresasPermitidas(req.user, { db })` após a verificação do papel admin.
  - Para `multiempresa=1` e `todas_empresas=1`, passa ao dry-run somente os IDs retornados pelo serviço oficial; não passa mais `empresaIds: null`.
  - Nega a operação com `403` e `EMPRESA_NAO_AUTORIZADA` se não houver empresas permitidas.
  - Para consulta individual, confere que `req.empresaId` está na lista autorizada antes de invocar o serviço.
- `tests/financeiro/mcf-02.2-interface-dry-run.test.js`
  - Amplia fixtures SQLite `:memory:` e cobertura da autorização, incluindo observação das empresas efetivamente consultadas internamente.
- `docs/financeiro/SPRINT-FIN-INT-07C-RELATORIO.md`
  - Registra a implementação e a validação desta sprint.

Não foram alterados o serviço de reconciliação, o SQL financeiro de negócio, o frontend, nem outros módulos.

## 3. Estratégia de autorização

1. A verificação existente de `role === 'admin'` permanece.
2. A rota obtém as empresas permitidas por `UsuarioEmpresaService.listarEmpresasPermitidas`, que considera vínculo ativo do usuário e empresa ativa.
3. Nas duas flags, os IDs dessa lista são passados explicitamente a `executarDryRunMultiempresa`. Não há fallback para todas as empresas ativas.
4. Na consulta individual, a empresa do contexto deve pertencer à mesma lista autorizada.
5. A resolução do contexto empresarial continua obrigatória. Ausência de contexto e tentativa de selecionar empresa sem vínculo são rejeitadas pelo middleware antes de iniciar o dry-run.
6. Não foi criada exceção global para administradores.

## 4. Comportamento antes e depois

**Antes:** as flags multiempresa acionavam `executarDryRunMultiempresa` com `empresaIds: null`, fazendo o serviço enumerar todas as empresas ativas. A consulta individual usava `req.empresaId`.

**Depois:** as flags recebem somente os IDs de vínculos ativos autorizados. A consulta individual mantém o contexto e o formato de resposta existentes, com validação explícita de vínculo na rota. Usuários não administradores continuam recebendo `403`.

## 5. Testes executados

Comando:

```text
node --test tests\financeiro\mcf-02.2-interface-dry-run.test.js
```

Resultado final: **10 testes passaram; 0 falharam**.

Cobertura da autorização:

- Admin vinculado somente à empresa A, com B ativa sem vínculo: ambas as flags são exercitadas individualmente; somente A aparece nos resultados e totais.
- Verificação de escopo interno: o teste instrumenta as consultas `FROM financeiro` e `FROM contas_pagar` e confirma que nenhuma consulta do dry-run é executada para B no caso de vínculo apenas com A.
- Admin vinculado a A e B: ambas são processadas.
- Não administrador com flag multiempresa: acesso negado sem consultas do dry-run.
- Ausência de contexto: resposta `400`, sem consultas do dry-run.
- Consulta individual de A autorizada: executada para A.
- Tentativa individual de B sem vínculo e usuário sem vínculos: acesso negado sem consultas do dry-run.
- O teste existente também verifica que o serviço não contém SQL de escrita.

Todos os cenários usam SQLite `:memory:` e fixtures criadas pelo teste; não houve conexão com banco oficial ou de cliente, nem operação financeira.

## 6. Limitações e riscos restantes

- A cobertura de consultas internas instrumenta as chamadas SQL do serviço por empresa no teste de integração da rota; não foi executada uma suíte completa do repositório.
- O comportamento de erro sem contexto é fornecido pelo middleware empresarial existente e foi validado no fixture multiempresa do teste.
- A lista de permissões é consultada a cada requisição, sem cache novo ou alteração do serviço de vínculos.

## 7. Estado

Implementação e testes focados concluídos. Nenhuma migração, backfill, reconciliação ou alteração de dados foi executada. A sprint para e aguarda homologação do Tech Lead.
