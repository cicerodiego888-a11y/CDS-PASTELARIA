# Implementação 05.04 — Carrinho universal e identificação por empresa

**Status:** concluída · **Sem checkout / reserva / venda / atendimento**

## Identidade do item

`produto_id` + `empresa_id`. Mesmo produto em A e B são linhas distintas.

## Identificação operacional

- **EMPRESA_UNICA:** exige empresa do contexto. Sem ela → `EMPRESA_OPERACIONAL_NAO_SELECIONADA`. Sem saldo nessa empresa → `PRODUTO_SEM_DISPONIBILIDADE`.
- **MULTIEMPRESA:** 0 empresas com saldo → bloqueia; 1 → automática (`UNICA_COM_DISPONIBILIDADE`); 2+ → escolha do operador. Nunca a primeira da lista nem empresa 1.

## Disponibilidade

`GET /api/pdv-universal/produtos/:produtoId/disponibilidade`  
→ `PDVUniversalDisponibilidadeService` → `reservasPublico.consultarDisponibilidade` por empresa operacional do operador. Sem linha em `estoque_empresa` = 0. Sem saldo global.

## Carrinho

Módulo `PDVUniversalCart` (estado de frontend). Total = preview. FINALIZAR com itens → `CHECKOUT_AINDA_NAO_IMPLEMENTADO`.

## Busca

`GET /api/produtos/consulta-pdv/buscar` (MIB existente).
