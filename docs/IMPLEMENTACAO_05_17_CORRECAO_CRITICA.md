# Implementação 05.17 — correção crítica

Correção do fluxo existente (Empresas + PDV Universal). Sem motor novo.

- URLs: uma regra (`urlAbsoluta` / `recursoSemPrefixoApi`).
- ID da empresa: `resolverEmpresaId`.
- Cache ERP: `cdsErpAsset` + recarga se a query `v` mudar.
- Status fiscal falho: aviso + TENTAR NOVAMENTE, abas permanecem.
- PDV: 409 não é sessão; `cds_empresa_id` inválido limpa e refaz GET.
