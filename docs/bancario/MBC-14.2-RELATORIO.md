# MBC-14.2 — Relatório de homologação

## 1. Status

CONCLUÍDA COM RESSALVAS

## 2. Classificação

INFRAESTRUTURA PREPARADA

PREPARADA, AGUARDANDO CONFIGURAÇÃO REAL DO CLOUDFLARE.

## 3. cloudflared

não instalado (instalação não executada automaticamente)

## 4. domínio

não configurado

## 5. hostname

não configurado

## 6. Tunnel

não configurado

## 7. HTTPS

não homologado (sem hostname público)

## 8. Gateway 3010

OK (MBC-14.1 preservado; bind 127.0.0.1)

## 9. ERP 3001

protegido (fora do Tunnel; JWT intacto)

## 10. SQLite

não exposto

## 11. Mercado Pago

NÃO HOMOLOGADO

## 12. Testes

23/23 (`motor-bancario-14-2.test.js`)

## 13. Regressão

MBC-01 a MBC-14.2: 607/607 · 05.38.D 20/20 · 05.41 14/14 · 05.38.C 17/17 · 05.40 13/13 · 05.64 OK

## 14. Pendências

- Instalar cloudflared no equipamento autorizado
- Conta Cloudflare + Tunnel nomeado
- Domínio e hostname permanentes
- Arquivo de credencial fora do Git
- Preencher variáveis de ambiente
- Só então testar HTTPS público e cadastrar Redirect URI (sprint futura)

## 15. Riscos

- Usar Quick Tunnel como se fosse produção
- Publicar 3001
- Commitar credencial
- Inventar domínio no código

## 16. Decisão final

NO-GO
