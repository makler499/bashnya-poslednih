# Звук и шкала лавки Tower Survivors 2.0

Шкала использует текстуры оригинального ProgressBar и время жизни лавки из скрипта карты. Первый интервал длится 60 секунд, включая 30 секунд подготовки, последующие — 30 секунд. Ручное обновление пересоздаёт лавку с полным индикатором на оставшееся время до автоматической смены. Браузерная кнопка раннего старта сокращает первый интервал в локальных режимах. Вид шкалы в запущенном Warcraft III отдельно не сверялся.

## Звуковые ресурсы

Записи карты загружаются непосредственно из веб-сборки. Варианты, события и высота тона получены из звуковых таблиц Warcraft III и ключей SND в моделях. В браузере звук ограничен количеством одновременных голосов. Фоновый список SetMapMusic("Music") и пространственный микшер Warcraft III пока не перенесены.

Дневной и ночной фон также недоступны. Для `SetAmbientDaySound("LordaeronWinterDay")` требуется `Sound/Ambient/LordaeronWinter/LordaeronWinterDay.flac`, для `SetAmbientNightSound("LordaeronWinterNight")` — `Sound/Ambient/LordaeronWinter/LordaeronWinterNight.flac`. Оба пути указаны в `AmbientMusic.slk`.

Для подключения отсутствующих записей нужны файлы из полной установки Warcraft III по указанным путям. Их можно загрузить через «Файлы звука» или добавить в сборку. Для ключей без найденной записи нужны соответствующие строки AnimLookups.slk и звуковых таблиц версии Warcraft III, из которой происходит модель.

| Ключ и фаза модели | Модель | Точный путь записи |
| --- | --- | --- |
| `MCRH` · Death | `abilities/weapons/cryptfiendmissile/cryptfiendmissile.mdx` | `Abilities/Weapons/CryptFiendMissile/CryptFiendMissileHit1.flac`<br>`Abilities/Weapons/CryptFiendMissile/CryptFiendMissileHit2.flac`<br>`Abilities/Weapons/CryptFiendMissile/CryptFiendMissileHit3.flac` |
| `MCRL` · Birth | `abilities/weapons/cryptfiendmissile/cryptfiendmissile.mdx` | `Abilities/Weapons/CryptFiendMissile/CryptFiendMissileLaunch1.flac`<br>`Abilities/Weapons/CryptFiendMissile/CryptFiendMissileLaunch2.flac`<br>`Abilities/Weapons/CryptFiendMissile/CryptFiendMissileLaunch3.flac` |
| `DHLB` · Death | `buildings/human/altarofkings/altarofkings.mdx`<br>`buildings/naga/altarofdepths/altarofdepths.mdx`<br>`buildings/other/dragonbuilding/dragonbuilding.mdx`<br>`buildings/other/dragonbuildingblue/dragonbuildingblue.mdx`<br>`buildings/other/dragonbuildinggreen/dragonbuildinggreen.mdx` | `Sound/Buildings/Death/BuildingDeathLargeHuman2.flac`<br>`Sound/Buildings/Death/BuildingDeathLargeHuman3.flac` |
| `DELB` · Death Alternate | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/ancientoflore/ancientoflore.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | `Sound/Buildings/Death/NightElfBuildingDeathLarge1.flac`<br>`Sound/Buildings/Death/NightElfBuildingDeathLarge2.flac`<br>`Sound/Buildings/Death/NightElfBuildingDeathLarge3.flac` |
| `DELS` · Death | `buildings/nightelf/altarofelders/altarofelders.mdx`<br>`buildings/nightelf/chimaeraroost/chimaeraroost.mdx`<br>`buildings/nightelf/huntershall/huntershall.mdx` | `Sound/Buildings/Death/NightElfBuildingDeathSmall1.flac` |
| `DOLB` · Death | `buildings/orc/altarofstorms/altarofstorms.mdx`<br>`buildings/orc/orcbarracks/orcbarracks.mdx`<br>`buildings/orc/trollburrow/trollburrow.mdx` | `Sound/Buildings/Death/BuildingDeathLargeOrc2.flac`<br>`Sound/Buildings/Death/BuildingDeathLargeOrc3.flac` |
| `DOLS` · Death | `buildings/orc/taurentotem/taurentotem.mdx`<br>`buildings/orc/voodoolounge/voodoolounge.mdx`<br>`buildings/orc/watchtower/watchtower.mdx`<br>`buildings/other/harpynest/harpynest.mdx` | `Sound/Buildings/Death/OrcBuildingDeathSmall2.flac`<br>`Sound/Buildings/Death/OrcBuildingDeathSmall3.flac` |
| `DULB` · Death | `buildings/other/sacrificialaltar/sacrificialaltar.mdx`<br>`buildings/undead/boneyard/boneyard.mdx`<br>`buildings/undead/hauntedmine/hauntedmine.mdx`<br>`buildings/undead/sacrificialpit/sacrificialpit.mdx`<br>`buildings/undead/slaughterhouse/slaughterhouse.mdx`<br>`buildings/undead/tombofrelics/tombofrelics.mdx` | `Sound/Buildings/Death/UndeadBuildingDeathLarge1.flac`<br>`Sound/Buildings/Death/UndeadBuildingDeathLarge2.flac`<br>`Sound/Buildings/Death/UndeadBuildingDeathLarge3.flac` |
| `DEBA` · Death | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/ancientoflore/ancientoflore.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | `Sound/Buildings/Death/AncientUprootDeath1.flac`<br>`Sound/Buildings/Death/AncientUprootDeath2.flac`<br>`Sound/Buildings/Death/AncientUprootDeath3.flac` |
| `DDRY` · Death | `units/nightelf/dryad/dryad.mdx` | `Units/NightElf/Dryad/DryadDeath1.flac` |
| `AEAT` · Spell Eat Tree, Spell EatTree | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/ancientoflore/ancientoflore.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | `Abilities/Spells/NightElf/EatTree/EatTreeTarget1.flac` |
| `MFDL` · Birth | `abilities/weapons/faeriedragonmissile/faeriedragonmissile.mdx` | `Abilities/Weapons/FaerieDragonMissile/FaerieDragonAttack.flac` |
| `MFBL` · Birth | `war3mapimported/frostboltmissile.mdx` | `Abilities/Spells/Other/FrostBolt/FrostBoltLaunch1.flac` |
| `DFRM` · Death | `buildings/other/frostmourne/frostmourne.mdx` | `Buildings/Other/Frostmourne/FrostmourneDeath.flac` |
| `MGRH` · Death | `abilities/weapons/gargoylemissile/gargoylemissile.mdx`<br>`abilities/weapons/wingedserpentmissile/wingedserpentmissile.mdx` | `Abilities/Weapons/GargoyleMissile/GargoyleMissileHit1.flac`<br>`Abilities/Weapons/GargoyleMissile/GargoyleMissileHit2.flac`<br>`Abilities/Weapons/GargoyleMissile/GargoyleMissileHit3.flac` |
| `KDK1` · Attack -1 | `units/undead/evilarthas/undeadarthas.mdx` | `Units/Undead/HeroDeathKnight/HeroDeathKnightAttack1.flac` |
| `DDKN` · Death | `units/undead/evilarthas/undeadarthas.mdx` | `Units/Undead/HeroDeathKnight/HeroDeathKnightDeath.flac` |
| `DHYD` · Death | `units/critters/hydralisk/hydralisk.mdx` | `Units/Critters/Hydralisk/HydraliskDeath1.flac` |
| `MKGH` · Death | `war3mapimported/keepergrovemissile.mdx`<br>`war3mapimported/orbofdeathmissile.mdx` | `Abilities/Weapons/KeeperGroveMissile/KeeperOfTheGroveMissileHit1.flac`<br>`Abilities/Weapons/KeeperGroveMissile/KeeperOfTheGroveMissileHit2.flac`<br>`Abilities/Weapons/KeeperGroveMissile/KeeperOfTheGroveMissileHit3.flac` |
| `DKOB` · Death | `units/critters/shoveler/shoveler.mdx` | `Units/Creeps/Kobold/KoboldDeath.flac` |
| `AHTF` · Birth | `units/creeps/herotinkerfactory/herotinkerfactory.mdx` | `Units/Creeps/HeroTinkerFactory/PocketFactoryBirth.flac` |
| `AROO` · Morph | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/ancientoflore/ancientoflore.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | `Abilities/Spells/NightElf/Root/Root.flac` |
| `AUB1` · Birth | `sharedmodels/ubirth.mdx` | `Sound/Buildings/Undead/UndeadBuildingBirth1.flac` |
| `AUB2` · Birth | `sharedmodels/ubirth.mdx` | `Sound/Buildings/Undead/UndeadBuildingBirth2.flac` |
| `AUB3` · Birth | `sharedmodels/ubirth.mdx` | `Sound/Buildings/Undead/UndeadBuildingBirth3.flac` |
| `AUB4` · Birth | `sharedmodels/ubirth.mdx` | `Sound/Buildings/Undead/UndeadBuildingBirth4.flac` |
| `AUPR` · Morph Alternate, morph alternate | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/ancientoflore/ancientoflore.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | `Abilities/Spells/NightElf/Uproot/Uproot.flac` |
| `AABM` | `units/undead/abomination/abomination.mdx` | Нет соответствия в доступной звуковой таблице |
| `ADFL` · Walk | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | Нет соответствия в доступной звуковой таблице |
| `ADFR` · Walk | `buildings/demon/corruptedtreeoflife/corruptedtreeoflife.mdx`<br>`buildings/nightelf/treeoflife/treeoflife.mdx` | Нет соответствия в доступной звуковой таблице |
| `MSEH` · Death | `abilities/weapons/sentinelmissile/sentinelmissile.mdx` | Метка `SentinelMissileHit` есть в `AnimLookups.slk`; в `AnimSounds.slk` имя файла отсутствует |
