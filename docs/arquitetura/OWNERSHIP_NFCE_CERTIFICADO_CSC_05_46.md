# OWNERSHIP NFC-e, CERTIFICADO E CSC — Sprint 05.46

**Status:** implementado  
**Data:** 2026-08-26  
**Dependência:** 05.40 (`vendas.empresa_id`), 04.08/04.09 (`empresas_configuracao_fiscal`)

## Invariante

```
VENDA
  ↓
vendas.empresa_id          ← ownership
  ↓
EMPRESA FISCAL
  ↓
empresas_configuracao_fiscal (mesma empresa)
  ├── certificado
  ├── CSC / ID CSC
  ├── ambiente
  ├── série
  └── numeração
  ↓
NFC-e (autorizar / consultar / cancelar)
```

O contexto do usuário **autoriza**. Nunca substitui `vendas.empresa_id`.

## Fluxo correto

1. Localizar a venda.
2. `exigirEmpresaFiscalDaVenda` → `venda.empresa_id` obrigatório.
3. Se houver `empresaIdContexto` e for diferente → `VENDA_NAO_ENCONTRADA` (404).
4. `getFiscalConfig({ empresaId })` / `resolverCredenciaisNfceDaEmpresa`.
5. Sem linha da empresa → falha. Sem fallback global.
6. Transmitir / cancelar com certificado e CSC dessa config.

## Ponto único

`backend/services/fiscal/FiscalEmpresaContextoService.js`

- `resolverEmpresaFiscalDaVenda` / `exigirEmpresaFiscalDaVenda`
- `exigirContextoFiscalDaEmpresa`
- `resolverCredenciaisNfceDaEmpresa`
- `obterCertificadoDaEmpresa`

## Legado

`vendas.empresa_id IS NULL` → `EMPRESA_OWNERSHIP_REQUIRED` **antes** de numerar, transmitir, cancelar ou criar evento.

Não se infere empresa por caixa, usuário, MUV, COMPAT ou config global.

## Leituras

`GET /api/fiscal/notas` e `GET /api/fiscal/notas/:id` filtram por `vendas.empresa_id` do contexto. Cruzado → 404.

## O que permanece C (não é NFC-e da venda PDV)

- `GET/PUT /api/fiscal/config` — perfil global EMPRESA_UNICA / Plataforma Fiscal
- Upload PFX sem `empresa_id` — `certificado.pfx` global
- NF-e 55 (`nfeEmissorVenda`, `cancelarNfe`, devolução 55)
- DistDFe / Central de Entradas (ownership próprio 05.43)

## Numeração

Já isolada em 04.08: `MAX(numero)` + `numero_atual` por `empresa_id` + série + ambiente. Esta sprint garante que a emissão da venda **chame** esse caminho (não o MAX global).
