# Sprint 05.15 — Gestão fiscal visual por empresa/CNPJ

## Fluxo visual

Configurações → Configurações Avançadas → Empresas  
→ lista / + NOVA EMPRESA (só dados gerais)  
→ SALVAR EMPRESA → edição automática  
→ abas DADOS GERAIS | CONFIGURAÇÃO FISCAL | CERTIFICADO DIGITAL

## Campos oficiais (04.09 / `empresasConfiguracaoFiscal.js`)

GET público: `ambiente`, `ambiente_label`, `uf`, `serie`, `numero_atual`, `id_csc_configurado`, `csc_configurado`, `certificado_configurado`, `certificado_nome`, `sefaz_configurado`, `status`, `campos`.

PUT parcial (somente se preenchido): `ambiente`, `uf`, `serie`, `numero_atual`, `id_csc`, `token_csc`, `ws_autorizacao`.

SEFAZ: o GET não devolve a URL; só o flag `sefaz_configurado`. A UI aceita `ws_autorizacao` para incluir/substituir.

## CSC

Nunca volta no GET. Após salvar: “CSC configurado”. Campo password. Vazio no PUT não apaga o token existente.

## Certificado

`POST /api/fiscal/certificado/upload` com `empresa_id` + arquivo + senha só no envio. Arquivo oficial `certificado-empresa-{id}.pfx`. UI mostra nome-base e ●/○.

## Endpoints

- `GET/POST /api/empresas`
- `GET/PUT /api/empresas/:id`
- `GET /api/empresas/configuracao-fiscal/status`
- `GET/PUT /api/empresas/:empresaId/configuracao-fiscal`
- `POST /api/fiscal/certificado/upload`

URLs passam por `urlAbsoluta` para não gerar `/api/api`.

## Segurança

Sem senha, CSC, path ou PFX no GET. `empresa_id` da URL prevalece (`EMPRESA_CONFIGURACAO_DIVERGENTE`). Sem fallback para empresa 1.

## Limitações

URLs SEFAZ e CSC já gravados não retornam para o formulário (DTO seguro). Recarregar a página após criar/salvar para ver abas se o shell ERP recriar o DOM.
