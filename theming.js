// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Signals = imports.signals;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const AppDisplay = imports.ui.appDisplay;
const AppFavorites = imports.ui.appFavorites;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;

/**
 * Manage theme customization and custom theme support
 */
const ThemeManager = new Lang.Class({
    Name: 'DashToDock.ThemeManager',

    _init: function(settings, actor, dash) {
        this._settings = settings;
        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._bindSettingsChanges();
        this._actor = actor;
        this._dash = dash;

        // initialize colors with generic values
        this._customizedBackground = {red: 0, green: 0, blue: 0, alpha: 0};
        this._customizedBorder = {red: 0, green: 0, blue: 0, alpha: 0};
        this._transparency = new Transparency(this._settings, this._dash, this._actor);

        this._signalsHandler.add([
            // When theme changes re-obtain default background color
            St.ThemeContext.get_for_stage (global.stage),
            'changed',
            Lang.bind(this, this.updateCustomTheme)
        ], [
            // update :overview pseudoclass
            Main.overview,
            'showing',
            Lang.bind(this, this._onOverviewShowing)
        ], [
            Main.overview,
            'hiding',
            Lang.bind(this, this._onOverviewHiding)
        ]);

        this._updateCustomStyleClasses();

        // destroy themeManager when the managed actor is destroyed (e.g. extension unload)
        // in order to disconnect signals
        this._actor.connect('destroy', Lang.bind(this, this.destroy));

    },

    destroy: function() {
        this._signalsHandler.destroy();
        this._transparency.destroy();
    },

    _onOverviewShowing: function() {
        this._actor.add_style_pseudo_class('overview');
    },

    _onOverviewHiding: function() {
        this._actor.remove_style_pseudo_class('overview');
    },

    _updateDashOpacity: function() {
        let newAlpha = this._settings.get_double('background-opacity');

        let [backgroundColor, borderColor] = this._getDefaultColors();

        if (backgroundColor==null)
            return;

        // Get the background and border alphas. We check the background alpha
        // for a minimum of .001 to prevent division by 0 errors
        let backgroundAlpha = Math.max(Math.round(backgroundColor.alpha/2.55)/100, .001);
        let borderAlpha = Math.round(borderColor.alpha/2.55)/100;

        // The border and background alphas should remain in sync
        // We also limit the borderAlpha to a maximum of 1 (full opacity)
        borderAlpha = Math.min((borderAlpha/backgroundAlpha)*newAlpha, 1);

        // We need to send the original border alpha to the transparency class
        this._transparency.setAlpha(newAlpha, borderAlpha, Math.round(borderColor.alpha/2.55)/100);

        this._customizedBackground = 'rgba(' +
            backgroundColor.red + ',' +
            backgroundColor.green + ',' +
            backgroundColor.blue + ',' +
            newAlpha + ')';

        this._customizedBorder = 'rgba(' +
            borderColor.red + ',' +
            borderColor.green + ',' +
            borderColor.blue + ',' +
            borderAlpha + ')';

    },

    _getDefaultColors: function() {
        // Prevent shell crash if the actor is not on the stage.
        // It happens enabling/disabling repeatedly the extension
        if (!this._dash._container.get_stage())
            return [null, null];

        // Remove custom style
        let oldStyle = this._dash._container.get_style();
        this._dash._container.set_style(null);

        let themeNode = this._dash._container.get_theme_node();
        this._dash._container.set_style(oldStyle);

        let backgroundColor = themeNode.get_background_color();

        // Just in case the theme has different border colors ..
        // We want to find the inside border-color of the dock because it is
        // the side most visible to the user. We do this by finding the side
        // opposite the position
        let position = Utils.getPosition(this._settings);
        let side = position + 2;
        if (side > 3)
            side = Math.abs(side - 4);

        let borderColor = themeNode.get_border_color(side);

        return [backgroundColor, borderColor];
    },

    _updateDashColor: function() {
        let [backgroundColor, borderColor] = this._getDefaultColors();

        if (backgroundColor==null)
            return;

        if (this._settings.get_boolean('custom-background-color')) {
            let newAlpha = Math.round(backgroundColor.alpha/2.55)/100;
            if (this._settings.get_boolean('opaque-background'))
                newAlpha = this._settings.get_double('background-opacity');

            backgroundColor = Clutter.color_from_string(this._settings.get_string('background-color'))[1];
            this._customizedBackground = 'rgba(' +
                backgroundColor.red + ',' +
                backgroundColor.green + ',' +
                backgroundColor.blue + ',' +
                newAlpha + ')';

            this._customizedBorder = this._customizedBackground;
        }
        this._transparency.setColor(backgroundColor);
    },

    _updateCustomStyleClasses: function() {
        if (this._settings.get_boolean('apply-custom-theme'))
            this._actor.add_style_class_name('dashtodock');
        else
            this._actor.remove_style_class_name('dashtodock');

        if (this._settings.get_boolean('custom-theme-shrink'))
            this._actor.add_style_class_name('shrink');
        else
            this._actor.remove_style_class_name('shrink');

        if (this._settings.get_boolean('custom-theme-running-dots'))
            this._actor.add_style_class_name('running-dots');
        else
            this._actor.remove_style_class_name('running-dots');

        // If not the built-in theme option is not selected
        if (!this._settings.get_boolean('apply-custom-theme')) {
            if (this._settings.get_boolean('force-straight-corner'))
                this._actor.add_style_class_name('straight-corner');
            else 
                this._actor.remove_style_class_name('straight-corner');
        } else {
            this._actor.remove_style_class_name('straight-corner');
        }
    },

    updateCustomTheme: function() {
        this._updateCustomStyleClasses();
        this._updateDashOpacity();
        this._updateDashColor();
        this._adjustTheme();
        this._dash._redisplay();
    },

    /**
     * Reimported back and adapted from atomdock
     */
    _adjustTheme: function() {
        // Prevent shell crash if the actor is not on the stage.
        // It happens enabling/disabling repeatedly the extension
        if (!this._dash._container.get_stage())
            return;

        // Remove prior style edits
        this._dash._container.set_style(null);
        this._transparency.disable();

        // If built-in theme is enabled do nothing else
        if (this._settings.get_boolean('apply-custom-theme'))
            return;

        let newStyle = '';
        let position = Utils.getPosition(this._settings);

        if (!this._settings.get_boolean('custom-theme-shrink')) {
            // obtain theme border settings
            let themeNode = this._dash._container.get_theme_node();
            let borderColor = themeNode.get_border_color(St.Side.TOP);
            let borderWidth = themeNode.get_border_width(St.Side.TOP);
            let borderRadius = themeNode.get_border_radius(St.Corner.TOPRIGHT);

            // We're copying border and corner styles to left border and top-left
            // corner, also removing bottom border and bottom-right corner styles
            let borderInner = '';
            let borderRadiusValue = '';
            let borderMissingStyle = '';

            if (this._rtl && (position != St.Side.RIGHT))
                borderMissingStyle = 'border-right: ' + borderWidth + 'px solid ' +
                       borderColor.to_string() + ';';
            else if (!this._rtl && (position != St.Side.LEFT))
                borderMissingStyle = 'border-left: ' + borderWidth + 'px solid ' +
                       borderColor.to_string() + ';';

            switch (position) {
            case St.Side.LEFT:
                borderInner = 'border-left';
                borderRadiusValue = '0 ' + borderRadius + 'px ' + borderRadius + 'px 0;';
                break;
            case St.Side.RIGHT:
                borderInner = 'border-right';
                borderRadiusValue = borderRadius + 'px 0 0 ' + borderRadius + 'px;';
                break;
            case St.Side.TOP:
                borderInner = 'border-top';
                borderRadiusValue = '0 0 ' + borderRadius + 'px ' + borderRadius + 'px;';
                break;
            case St.Side.BOTTOM:
                borderInner = 'border-bottom';
                borderRadiusValue = borderRadius + 'px ' + borderRadius + 'px 0 0;';
                break;
            }

            newStyle = borderInner + ': none;' +
                'border-radius: ' + borderRadiusValue +
                borderMissingStyle;

            // I do call set_style possibly twice so that only the background gets the transition.
            // The transition-property css rules seems to be unsupported
            this._dash._container.set_style(newStyle);
        }

        // Customize background
        if (this._settings.get_boolean('opaque-background') && this._settings.get_boolean('dynamic-opaque-background')) {
            this._transparency.enable();
        }
        else if (this._settings.get_boolean('opaque-background') || this._settings.get_boolean('custom-background-color')) {
            newStyle = newStyle + 'background-color:'+ this._customizedBackground + '; ' +
                       'border-color:'+ this._customizedBorder + '; ' +
                       'transition-delay: 0s; transition-duration: 0.250s;';
            this._dash._container.set_style(newStyle);
            this._transparency.disable();
        }
    },

    _bindSettingsChanges: function() {
        let keys = ['opaque-background',
                    'dynamic-opaque-background',
                    'background-opacity',
                    'custom-background-color',
                    'background-color',
                    'apply-custom-theme',
                    'custom-theme-shrink',
                    'custom-theme-running-dots',
                    'extend-height',
                    'force-straight-corner'];

        keys.forEach(function(key) {
            this._signalsHandler.add([
                this._settings,
                'changed::' + key,
                Lang.bind(this, this.updateCustomTheme)
           ]);
        }, this);
    }
});

/**
 * The following class is based on the following upstream commit:
 * https://git.gnome.org/browse/gnome-shell/commit/?id=447bf55e45b00426ed908b1b1035f472c2466956
 * Transparency when free-floating
 */
const Transparency = new Lang.Class({
    Name: 'DashToDock.Transparency',

    _init: function(settings, dash, dockActor) {
        this._settings = settings;
        this._actor = dash._container;
        this._dash = dash;
        this._dockActor = dockActor;
        this._position = Utils.getPosition(this._settings);

        this._backgroundColor = '0,0,0';
        this._alpha = '1';
        this._borderAlpha = '1';
        this._originalBorderAlpha = '1';
        this._updateStyles();

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._trackedWindows = new Map();
    },

    enable: function() {
        // ensure I never double-register/inject
        // although it should never happen
        this.disable();

        this._signalsHandler.addWithLabel('transparency', [
            global.window_group,
            'actor-added',
            Lang.bind(this, this._onWindowActorAdded)
        ], [
            global.window_group,
            'actor-removed',
            Lang.bind(this, this._onWindowActorRemoved)
        ], [
            global.window_manager,
            'switch-workspace',
            Lang.bind(this, this._updateSolidStyle)
        ]);

        // Window signals
        global.get_window_actors().forEach(function(win) {
            if (win.get_meta_window().get_wm_class() !== 'Gnome-shell')
                this._addWindowSignals(win);
        }, this);

        if (this._actor.get_stage())
            this._updateSolidStyle();
    },

    disable: function() {
        // ensure I never double-register/inject
        // although it should never happen
        this._signalsHandler.removeWithLabel('transparency');

        for (let key of this._trackedWindows.keys())
            this._trackedWindows.get(key).forEach(id => {
                key.disconnect(id);
            });
        this._trackedWindows.clear();
    },

    destroy: function() {
        this.disable();
        this._signalsHandler.destroy();
    },

    _addWindowSignals: function(metaWindowActor) {
        let signalIds = [];
        ['allocation-changed', 'notify::visible'].forEach(s => {
            signalIds.push(metaWindowActor.connect(s, Lang.bind(this, this._updateSolidStyle)));
        });
        this._trackedWindows.set(metaWindowActor, signalIds);
    },

    _onWindowActorAdded: function(container, metaWindowActor) {
        this._addWindowSignals(metaWindowActor);
    },

    _onWindowActorRemoved: function(container, metaWindowActor) {
        this._trackedWindows.get(metaWindowActor).forEach(id => {
            metaWindowActor.disconnect(id);
        });
        this._trackedWindows.delete(metaWindowActor);
        this._updateSolidStyle();
    },

    _updateSolidStyle: function() {
        if (this._dockActor.has_style_pseudo_class('overview'))
             return;
        /* Get all the windows in the active workspace that are in the primary monitor and visible */
        let activeWorkspace = global.screen.get_active_workspace();
        let dash = this._dash;
        let windows = activeWorkspace.list_windows().filter(function(metaWindow) {
            return metaWindow.get_monitor() === dash._monitorIndex &&
                   metaWindow.showing_on_its_workspace() &&
                   metaWindow.get_window_type() != Meta.WindowType.DESKTOP;
        });

        /* Check if at least one window is near enough to the panel */
        let [leftCoord, topCoord] = this._actor.get_transformed_position();
        let threshold;
        if (this._position === St.Side.LEFT)
            threshold = leftCoord + this._actor.get_width();
        else if (this._position === St.Side.RIGHT)
            threshold = leftCoord;
        else if (this._position === St.Side.TOP)
            threshold = topCoord + this._actor.get_height();
        else
            threshold = topCoord;

        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let isNearEnough = windows.some(Lang.bind(this, function(metaWindow) {
            let coord;
            if (this._position === St.Side.LEFT) {
                coord = metaWindow.get_frame_rect().x;
                return coord < threshold + 5 * scale;
            }
            else if (this._position === St.Side.RIGHT) {
                coord = metaWindow.get_frame_rect().x + metaWindow.get_frame_rect().width;
                return coord > threshold - 5 * scale;
            }
            else if (this._position === St.Side.TOP) {
                coord = metaWindow.get_frame_rect().y;
                return coord < threshold + 5 * scale;
            }
            else {
                coord = metaWindow.get_frame_rect().y + metaWindow.get_frame_rect().height;
                return coord > threshold - 5 * scale;
            }
        }));

        if (isNearEnough)
            this._actor.set_style(this._opaque_style);
        else
            this._actor.set_style(this._transparent_style);
    },

    _updateStyles: function() {
        this._transparent_style = 'background-color: rgba(' +
                                  this._backgroundColor + ',' + this._alpha + ');' +
                                  'border-color: rgba(' +
                                  this._backgroundColor + ',' + this._borderAlpha + ');' +
                                  'transition-duration: 500ms;';
        this._opaque_style = 'background-color: rgba(' +
                             this._backgroundColor + ',' + '1);' +
                             'border-color: rgba(' +
                             this._backgroundColor + ',' + this._originalBorderAlpha + ');' +
                             'transition-duration: 300ms;';
    },

    setColor: function(color) {
        this._backgroundColor = color.red + ',' + color.green + ',' + color.blue;
        this._updateStyles();
    },

    setAlpha: function(alpha, borderAlpha, originalBorderAlpha) {
        this._alpha = alpha.toString();
        borderAlpha = Math.round(borderAlpha*100)/100;
        this._borderAlpha = borderAlpha.toString();
        this._originalBorderAlpha = originalBorderAlpha.toString();
        this._updateStyles();
    }
});
