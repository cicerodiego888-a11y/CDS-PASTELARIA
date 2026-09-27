# MBC-14.3 — Visão multiempresa de contas bancárias

STATUS: implementado sobre MBC-02. Sem Open Finance real, sem alteração estrutural EMPRESA → CONTA_BANCARIA.

## Modelo

Uma conta bancária continua pertencendo a **uma** empresa. “Todas as empresas” é somente escopo de consulta (`escopo=todas`). Não existe empresa “TODAS” e não há fallback `empresa_id=1`.

## Contexto

- Empresa individual: `X-Empresa-Id` / `req.empresaId` + autorização `usuario_empresas`.
- Todas: query/body `escopo=todas` + `empresa_id IN` das empresas autorizadas do usuário.
- EMPRESA_SIMPLES: “todas” permanece a empresa operacional.

`empresa_id` no body/query **não** supera o contexto. Em visão individual é ignorado. Em “todas”, só vale se estiver no conjunto autorizado; senão HTTP 403.

## APIs (`GET/POST /api/bancario/contas`)

- Listagem individual: `{ visao: 'empresa', empresa_id, contas }` com Empresa/CNPJ no item.
- Listagem consolidada: `{ visao: 'todas', contas }` (sem `empresa_id` do grupo).
- Filtro: `?escopo=todas&empresa_id=` validado contra autorizadas.
- Criação em “todas”: exige empresa escolhida e autorizada.
- Edição: não transfere titularidade. Principal continua **uma por empresa**.

## UI

Financeiro → Contas Bancárias. Visão “Todas as empresas” ou empresa atual. Evento `cds-empresa-contexto-alterado` limpa seleção e recarrega.
