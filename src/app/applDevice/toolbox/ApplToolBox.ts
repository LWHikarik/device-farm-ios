import { ToolBox } from '../../toolbox/ToolBox';
import SvgImage from '../../ui/SvgImage';
import { BasePlayer } from '../../player/BasePlayer';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import { IosControlClient } from '../client/IosControlClient';

// iOS has no hardware back/app-switcher buttons: the DeviceKit backend
// synthesizes them as system gestures (left-edge swipe / swipe-up-and-hold).
const BUTTONS = [
    {
        title: 'Back',
        name: 'back',
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        name: 'home',
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'App switcher',
        name: 'appSwitcher',
        icon: SvgImage.Icon.OVERVIEW,
    },
];

export interface StreamClient {
    getDeviceName(): string;
}

export class ApplToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClient,
        wdaConnection: IosControlClient,
        moreBox?: HTMLElement,
    ): ApplToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            _: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.name) {
                return;
            }
            const { name } = element.optional;
            wdaConnection.pressButton(name);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                name: item.name,
            });
            button.addEventListener('click', handler);
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        if (moreBox) {
            const more = new ToolBoxCheckbox('More', SvgImage.Icon.MORE, `show_more_${udid}_${playerName}`);
            more.addEventListener('click', (_, el) => {
                const element = el.getElement();
                moreBox.style.display = element.checked ? 'block' : 'none';
            });
            elements.unshift(more);
        }
        return new ApplToolBox(elements);
    }
}
