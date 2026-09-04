# Modo MULTIEMPRESA na Central de Entradas — Sprint 05.54

**Status:** implementação  
**Data:** 2026-08-29  
**Escopo:** ativação **explícita** de `modo_operacional_global = MULTIEMPRESA`. Sem motor novo.

## Problema encontrado

A instalação do cliente tem **3 empresas ativas**. A Central recebia:

```
modo_operacional_global = EMPRESA_SIMPLES
```

Com mais de uma empresa ativa e sem `empresa_operacional_id`, o contrato falha com:

```
EMPRESA_OPERACIONAL_AMBIGUA
```

Isso **não** é um defeito do contrato: EMPRESA_SIMPLES exige uma empresa operacional determinística. O defeito operacional era o **modo global ainda estar em EMPRESA_SIMPLES**.

Contornar com “primeira empresa”, “empresa 1” ou `empresas.length > 1` **não é permitido**.

## EMPRESA_SIMPLES vs MULTIEMPRESA

| | EMPRESA_SIMPLES | MULTIEMPRESA |
|---|-----------------|--------------|
| Configuração | explícita | explícita |
| `modo_operacional` (contrato) | EMPRESA_SIMPLES | MULTIEMPRESA |
| `empresa_operacional` | 1 empresa resolvida pela política | **sempre `null`** |
| `empresa_operacional_id` | usado quando N>1 ativas | **não** escolhe alvo da Central; pode permanecer salvo |
| Alvos da Central | 1 CNPJ (o operacional) | todas as empresas **ativas** |
| Ambiguidade N>1 sem id | `EMPRESA_OPERACIONAL_AMBIGUA` | não se aplica |

## Configuração explícita

Fonte oficial: `configuracoes.json` via `configuracaoService`.

- **Leitura:** `obterModoOperacionalGlobal()` → `resolverModoOperacionalGlobalAtivo()` → `ContratoOperacionalService`.
- **Gravação:** `POST /api/configuracoes-avancadas` → `saveConfig()`.
- **Validação:** `validarModoOperacionalGlobal()`.
- **Legado:** `modo_operacao_venda` sincronizado com `modoGlobalParaModoVenda()` (`EMPRESA_SIMPLES` → `EMPRESA_UNICA`, `MULTIEMPRESA` → `MULTIEMPRESA`).
- Troca de modo exige `confirmacao_modo_operacional: true`.
- UI: Centro de Configurações (Configurações Avançadas), rádios EMPRESA_SIMPLES / MULTIEMPRESA. Não há detecção automática por quantidade de CNPJs.

Valor inválido é rejeitado. Default de arquivo novo continua `EMPRESA_SIMPLES` (não “vira” MULTIEMPRESA só porque há 3 empresas).

## Comportamento da Central

Nesta sprint a Central **não** ganhou loop, tabela de NSU, DistDFe, MIIP nem compras novos.

Fluxo já existente (05.38.E):

```
ContratoOperacionalService
        ↓
MULTIEMPRESA  (empresa_operacional = null)
        ↓
listarAlvosSincronizacaoCentral()
        ↓
Empresas ativas (A, B, C)
        ↓
_sincronizarEmpresa(alvo) por iteração
```

Cada alvo carrega `empresaId` + `CNPJ` próprios. NSU permanece por `(cnpj, ambiente)`. Erro de certificado/fiscal de uma empresa é retornado naquela iteração; não reescreve o contexto da próxima.

`empresa_operacional_id` residual **não** vira o único alvo em MULTIEMPRESA.

## Ausência de fallback

Não há:

- `empresas.length > 1` mudando o modo;
- primeira / última empresa / último CNPJ como operacional;
- uso de `empresa_operacional_id` como substituto de MULTIEMPRESA.

## Empresas no plano de sincronização (teste 05.54)

| Empresa | id | CNPJ |
|---------|----|------|
| A | 11 | 11111111000191 |
| B | 22 | 22222222000182 |
| C | 33 | 33333333000173 |

No fluxo de sync de teste, B simula certificado ausente (`CERTIFICADO` na linha da empresa 22); A e C sincronizam NSU distintos.

## Riscos não tratados nesta sprint

- NF-e 55, NFC-e, DistDFe interno, MIIP, Motor Comercial.
- Estoque, financeiro, caixa, reservas, lotes, FEFO, compras.
- TEF, Open Finance, Central Contábil.
- Backfill de legado `empresa_id` NULL.
- Blindagem adicional da Central (próxima micro-sprint).
- Instalação **real** do cliente: o modo só muda quando SUPER_ADMIN salva MULTIEMPRESA com confirmação. Esta sprint não altera o JSON de produção automaticamente.
