# Sprint FIN-INT-07B — Auditoria corretiva da autorização multiempresa do dry-run

**Tipo:** auditoria focada de autorização multiempresa  
**Data:** 2026-10-26  
**Homologação:** aguardando decisão do Tech Lead

## 1. Resumo executivo

A política atual **não define autorização global multiempresa para administradores** nos componentes inspecionados. O serviço `UsuarioEmpresaService` concede acesso a uma empresa com base em vínculo ativo do usuário e atividade da empresa; não há exceção por `role === 'admin'`.

O endpoint do dry-run exige papel `admin`, mas quando recebe `multiempresa=1` ou `todas_empresas=1` chama o serviço com `empresaIds: null`. Nesse caso, o serviço consulta todas as empresas ativas, sem limitar a lista aos vínculos do usuário. Portanto, há divergência entre a autorização individual por vínculo e o comportamento multiempresa do dry-run.

Como o contrato não define se administradores podem acessar globalmente todas as empresas, **a implementação foi interrompida conforme solicitado**. Nenhum código de produção ou teste foi alterado. É necessária decisão explícita do Tech Lead antes de corrigir o comportamento.

## 2. Política de autorização encontrada

- `UsuarioEmpresaService.usuarioPodeAcessarEmpresa` autoriza somente quando existe vínculo ativo entre o usuário e a empresa, e a empresa também está ativa.
- `UsuarioEmpresaService.exigirEmpresaAutorizada` aplica essa verificação e rejeita ausência de vínculo com erro de autorização.
- `UsuarioEmpresaService.listarEmpresasPermitidas` lista empresas ativas vinculadas ao usuário.
- Não foi encontrada nesses métodos exceção baseada em função administrativa nem um contrato de acesso global para administradores.
- A rota do dry-run verifica `req.user.role === 'admin'`. Essa verificação restringe o endpoint por papel, mas não estabelece por si só quais empresas esse administrador pode consultar.

**Conclusão:** o contrato examinado define autorização individual por vínculo, mas deixa indefinida a autorização global multiempresa para administradores.

## 3. Comportamento observado

### Antes

- A rota `GET /reconciliacao-historica/dry-run` aceita `multiempresa=1` ou `todas_empresas=1` após verificar apenas o papel `admin`.
- Para esses parâmetros, a rota chama `executarDryRunMultiempresa({ db, empresaIds: null })`.
- Sem uma lista explícita de IDs, o serviço enumera todas as empresas ativas e executa o dry-run de cada uma.
- Sem as flags, a rota passa `req.empresaId` ao serviço para executar a consulta individual no contexto resolvido pelo middleware da rota.

### Depois

Sem alteração. O comportamento atual foi mantido porque não há política homologada para definir se o administrador pode consultar empresas sem vínculo.

## 4. Arquivos e funções inspecionados

- `backend/rotas/contas_pagar.js`
  - `exigirAdminFinanceiro`
  - `GET /reconciliacao-historica/dry-run`
  - registro de `middlewareResolverEmpresaFinanceiro`
- `backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService.js`
  - `executarDryRun`
  - `executarDryRunMultiempresa`
- `backend/services/empresas/UsuarioEmpresaService.js`
  - `usuarioPodeAcessarEmpresa`
  - `exigirEmpresaAutorizada`
  - `listarEmpresasPermitidas`
- `tests/financeiro/mcf-02.2-interface-dry-run.test.js`
  - preparação isolada com SQLite `:memory:`
  - teste de acesso individual à API e papel não administrador

**Arquivos alterados:** somente este relatório.  
**Código de produção alterado:** não.  
**Testes adicionados ou modificados:** não.

## 5. Cenários obrigatórios e cobertura encontrada

| Cenário | Evidência encontrada |
|---|---|
| Admin vinculado somente à empresa A, com B ativa sem vínculo | Não coberto pelo teste existente. A política global necessária para decidir o resultado está indefinida. |
| Admin vinculado a A e B | O fixture atual cria vínculos para ambas; o teste realiza chamadas individuais para A e B. Não exercita as flags multiempresa. |
| Usuário não administrador | Coberto para chamada individual: a rota responde `403`. Não há teste correspondente usando flags multiempresa. |
| Requisição sem contexto empresarial obrigatório | Não coberto pelo teste existente; a rota usa middleware de contexto e `req.empresaId` no caminho individual. |
| Empresa não autorizada via `multiempresa=1` ou `todas_empresas=1` | Não coberto. O caminho atual não recebe IDs autorizados do usuário e, com `empresaIds: null`, enumera todas as empresas ativas. |
| Consulta individual de empresa autorizada | Coberto para A e B no fixture atual, cujo usuário está vinculado a ambas. |

O teste atual não comprova que as flags multiempresa respeitam vínculos. Também não comprova se a intenção do produto é permitir acesso global para administradores.

## 6. Testes executados

Executado:

```text
node --test tests\financeiro\mcf-02.2-interface-dry-run.test.js
```

Resultado: **8 testes passaram; 0 falharam**. Os testes usam SQLite `:memory:` e fixtures locais. O teste da API cobre o papel não administrador e as consultas individuais por A e B; não cobre autorização multiempresa por flags nem vínculo parcial.

## 7. Limitações e riscos restantes

- A definição de autorização global para `admin` não foi encontrada nos componentes especificados.
- Não foi possível concluir se o comportamento multiempresa atual é uma permissão intencional ou uma lacuna de autorização sem uma decisão de produto/arquitetura.
- Enquanto não houver decisão, as flags multiempresa podem fazer um administrador consultar empresas ativas sem vínculo explícito. O endpoint continua limitado ao papel `admin`, mas isso não substitui a autorização por empresa.
- A resposta multiempresa agrega totais gerais e resultados por empresa; a auditoria não avaliou a adequação funcional dessa consolidação, pois o objetivo desta sprint é exclusivamente a autorização.

## 8. Decisão necessária e próximo passo

O Tech Lead deve definir explicitamente uma das políticas:

1. **Sem acesso global:** administradores só consultam empresas com vínculo ativo; a rota deve fornecer ao serviço a lista autorizada e negar ou limitar a consulta quando uma flag solicitar empresas fora dessa lista.
2. **Com acesso global:** declarar formalmente que determinado papel administrativo possui acesso global, indicar a fonte de identidade/autorização que concede esse privilégio e definir como a rota valida essa política.

Até a decisão, não foram feitas alterações de produção nem adicionados testes que presumam uma das políticas. A sprint encerra-se com este diagnóstico e aguarda homologação.
