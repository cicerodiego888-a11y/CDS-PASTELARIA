# Sprint 05.11 — Gestão visual multiempresa

## Telas

- ERP: **Administração → Empresas** (`data-page="empresas"`).
- Atalho no Centro de Configurações (aba Empresa): **Abrir Empresas**.

## Rotas usadas (já existentes)

- `GET /api/empresas`
- `POST /api/empresas`
- `PUT /api/empresas/:id` (header `X-Empresa-Id` = empresa editada)
- `GET /api/empresas/configuracao-fiscal/status`
- `GET /api/empresas/:empresaId/configuracao-fiscal`
- `PUT /api/empresas/:empresaId/configuracao-fiscal`
- `POST /api/fiscal/certificado/upload` com `empresa_id` no FormData

## Contrato fiscal (04.09)

Status oficial: PRONTA, INCOMPLETA, INVALIDA, DESATIVADA. O frontend **não** calcula status.

GET público: flags (`csc_configurado`, `certificado_configurado`, `certificado_nome`). Sem senha, CSC ou path interno.

PUT: merge parcial. Campos vazios não são enviados. `empresa_id` do body não substitui o da URL.

## Certificado

Sem `empresa_id`: comportamento legado (`certificado.pfx` + config global).

Com `empresa_id` explícito: arquivo `certificado-empresa-{id}.pfx` no storage oficial e persistência em `empresas_configuracao_fiscal`. Sem fallback para empresa 1.

## Isolamento

Trocar empresa incrementa geração da sessão e recarrega GET da empresa alvo.

## Dados gerais

Apenas campos do `EmpresaService`: razão social, nome fantasia, CNPJ, IE, IM, ativo (leitura). Sem endereço fictício no cadastro.
